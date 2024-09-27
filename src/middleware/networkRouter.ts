import { Request, Response, NextFunction } from "express";
import { createProxyMiddleware, Options } from "http-proxy-middleware";
import NodeCache from "node-cache";
import { ServerCoin } from "@dignetwork/dig-sdk";

// Cache for peers, organized by storeId
const peerCache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes per storeId
const offlinePeersCache = new NodeCache({ stdTTL: 300 }); // Blacklist cache for 5 minutes

// Define the type for the epoch object (based on the structure returned by ServerCoin)
interface EpochData {
  epoch: number;
  round: number;
}

let currentEpoch: EpochData | null = null; // Track current epoch as an object

// Track store refresh intervals to avoid multiple intervals per store
const storeRefreshIntervals: { [storeId: string]: NodeJS.Timeout } = {};

/**
 * Function to seed the peer list for a specific storeId, or refresh if necessary
 * @param storeId - The store ID for which peers are seeded
 */
const seedPeerList = async (storeId: string): Promise<void> => {
  try {
    const serverCoin = new ServerCoin(storeId);
    const peersIpAddresses = await serverCoin.sampleCurrentEpoch(10); // Seed with up to 10 peers

    // Store peer list under the specific storeId in peerCache
    peerCache.set(storeId, peersIpAddresses.map(ip => ({
      ipAddress: ip,
      weight: 5,
      failureCount: 0,
      lastCheck: Date.now(),
      lastFailure: 0
    })));

    console.log(`Peer list seeded for storeId: ${storeId}`);
  } catch (error: any) {
    console.error(`Failed to seed peer list for storeId ${storeId}: ${error.message}`);
  }
};

/**
 * Refresh peer list for a given storeId if the epoch has changed or peers are exhausted
 * @param storeId - The store ID for which peers should be refreshed
 */
const refreshPeerListIfNeeded = async (storeId: string): Promise<void> => {
  try {
    const newEpoch = ServerCoin.getCurrentEpoch() as EpochData; // Assume ServerCoin.getCurrentEpoch() returns an object with epoch and round

    // Refresh peer list if the epoch has changed or no peers available for the storeId
    if (!currentEpoch || newEpoch.epoch !== currentEpoch.epoch || newEpoch.round !== currentEpoch.round || !peerCache.has(storeId)) {
      console.log(`Epoch changed or peer list exhausted for storeId ${storeId}. Refreshing peer list...`);
      currentEpoch = newEpoch;
      await seedPeerList(storeId);
    }
  } catch (error: any) {
    console.error(`Error refreshing peer list for storeId ${storeId}: ${error.message}`);
  }
};

/**
 * Set up periodic refresh for a specific storeId's peer list
 * @param storeId - The store ID for which periodic refresh should be set up
 */
const setupPeriodicRefresh = (storeId: string): void => {
  if (storeRefreshIntervals[storeId]) {
    // If a refresh interval already exists for this storeId, do nothing
    return;
  }

  // Set up periodic refresh every 30 minutes
  const interval = setInterval(() => {
    refreshPeerListIfNeeded(storeId);
  }, 30 * 60 * 1000); // Refresh every 30 minutes

  storeRefreshIntervals[storeId] = interval;

  console.log(`Periodic refresh set up for storeId: ${storeId}`);
};

/**
 * Middleware to proxy requests through cached peers
 */
export const networkRouter = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { chainName, storeId, rootHash } = req as any; // You may want to use a custom type for this if needed.

  // Extract the path after the first segment
  const key = req.path.split("/").slice(2).join("/"); // Skips the first path part

  // Function to get the next available peer from the cache for a specific storeId
  const getNextPeer = (storeId: string): string | null => {
    const peers = peerCache.get(storeId) as Array<{ ipAddress: string }> | undefined;
    
    if (!peers) {
      return null; // No peers found for the given storeId
    }

    const availablePeers = peers.filter(peer => !offlinePeersCache.has(peer.ipAddress));

    if (availablePeers.length === 0) {
      return null;
    }

    // Select a peer in round-robin or weighted fashion
    return availablePeers[Math.floor(Math.random() * availablePeers.length)].ipAddress;
  };

  try {
    // Refresh peer list for the storeId if needed in the background
    await refreshPeerListIfNeeded(storeId);

    // Set up periodic refresh for the storeId's peer list
    setupPeriodicRefresh(storeId);

    const peerIp = getNextPeer(storeId);

    if (!peerIp) {
      res.status(500).send(`No available peers for storeId: ${storeId}.`);
      return;
    }

    // Construct content URL using the selected peer
    let contentUrl = `http://${peerIp}:4161/${chainName}.${storeId}.${rootHash}`;
    if (key) {
      contentUrl += `/${key}`;
    }

    console.log(`Proxying request to ${contentUrl}`);

    const targetUrl = new URL(contentUrl);

    const proxyOptions: Options = {
      target: targetUrl.origin,
      changeOrigin: true,
      pathRewrite: () => `/${chainName}.${storeId}.${rootHash}/${key}`,
      // @ts-ignore
      onError: (err: any) => {
        // Mark peer as failed and blacklist temporarily
        offlinePeersCache.set(peerIp, true);
        console.error(`Peer ${peerIp} failed, added to blacklist.`);
        res.status(500).send("Proxy error");
      },
      onProxyReq: (proxyReq: any) => {
        proxyReq.setHeader("Host", targetUrl.host);
      },
      onProxyRes: () => {
        console.log(`Successfully proxied through peer ${peerIp}.`);
      },
    };

    const proxyMiddleware = createProxyMiddleware(proxyOptions);
    proxyMiddleware(req, res, next);
  } catch (error: any) {
    console.trace(`Failed to proxy request for storeId ${storeId}: ${error.message}`);
    res.status(500).send(error.message);
  }
};
