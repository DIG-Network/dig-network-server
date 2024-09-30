import { Request, Response, NextFunction } from "express";
import { createProxyMiddleware, Options } from "http-proxy-middleware";
import NodeCache from "node-cache";
import { ServerCoin, DigPeer } from "@dignetwork/dig-sdk";

// Cache for peers, organized by storeId
const peerCache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes per storeId
const offlinePeersCache = new NodeCache({ stdTTL: 300 }); // Blacklist cache for 5 minutes
const activeConnections: { [peerIp: string]: number } = {}; // Track active connections for least-connections balancing

interface EpochData {
  epoch: number;
  round: number;
}

interface PeerInfo {
  ipAddress: string;
  weight: number;
  failureCount: number;
  successCount: number;
  lastCheck: number;
  lastFailure: number;
  totalRequests: number;
  totalLatency: number; // Track total latency to compute average
}

let currentEpoch: EpochData | null = null;

// Track store refresh intervals to avoid multiple intervals per store
const storeRefreshIntervals: { [storeId: string]: NodeJS.Timeout } = {};

/**
 * Utility function to enforce a timeout on a promise
 */
const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string
): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage)), ms)
    ),
  ]);
};

/**
 * Function to seed the peer list for a specific storeId, or refresh if necessary
 * @param storeId - The store ID for which peers are seeded
 */
const seedPeerList = async (storeId: string): Promise<void> => {
  try {
    const serverCoin = new ServerCoin(storeId);
    const peersIpAddresses = await serverCoin.sampleCurrentEpoch(10); // Seed with up to 10 peers

    peerCache.set(storeId, peersIpAddresses.map(ip => ({
      ipAddress: ip,
      weight: 5,
      failureCount: 0,
      successCount: 0,
      lastCheck: Date.now(),
      lastFailure: 0,
      totalRequests: 0,
      totalLatency: 0
    })));

    peersIpAddresses.forEach(ip => activeConnections[ip] = 0); // Initialize active connections

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
    const newEpoch = ServerCoin.getCurrentEpoch() as EpochData;

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
    return;
  }

  const interval = setInterval(() => {
    refreshPeerListIfNeeded(storeId);
  }, 30 * 60 * 1000); // Refresh every 30 minutes

  storeRefreshIntervals[storeId] = interval;

  console.log(`Periodic refresh set up for storeId: ${storeId}`);
};

/**
 * Adjust the peer weights and success/failure tracking
 */
const adjustPeerStats = (peer: PeerInfo, success: boolean, latency: number): void => {
  peer.totalRequests += 1;
  peer.totalLatency += latency;

  if (success) {
    peer.successCount += 1;
    peer.weight = Math.min(peer.weight + 1, 10); // Increase weight, with a max of 10
    peer.failureCount = 0;
  } else {
    peer.failureCount += 1;
    peer.weight = Math.max(peer.weight - 1, 1); // Decrease weight, minimum of 1
    peer.lastFailure = Date.now();

    if (peer.failureCount >= 3) {
      offlinePeersCache.set(peer.ipAddress, true);
      console.log(`Peer ${peer.ipAddress} blacklisted after 3 failures.`);
    }
  }

  peer.lastCheck = Date.now();
};

/**
 * Validate a peer using either headStore or headKey depending on whether a key is provided
 * @param peer - The peer to validate
 * @param storeId - The storeId for which the peer is being tested
 * @param rootHash - The expected root hash to compare against
 * @param key - Optional. The resource key (as a hex string) to be validated.
 * @returns A boolean indicating if the peer has the correct root hash or key data
 */
const validatePeer = async (peer: PeerInfo, storeId: string, rootHash: string, key?: string): Promise<boolean> => {
  try {
    const digPeer = new DigPeer(peer.ipAddress, storeId);

    if (!key) {
      // No key provided, perform headStore
      const response = await withTimeout(
        digPeer.contentServer.headStore({ hasRootHash: rootHash}),
        5000,
        `headStore timed out for peer ${peer.ipAddress}`
      );
      const hasRootHash = response.headers?.["x-has-roothash"];
      if (hasRootHash === "true") {
        console.log(`Peer ${peer.ipAddress} has the correct root hash.`);
        return true;
      } else {
        console.error(`Peer ${peer.ipAddress} does not have the correct root hash.`);
        return false;
      }
    } else {
      // Key provided, perform headKey
      const response = await withTimeout(
        digPeer.contentServer.headKey(key, rootHash),
        5000,
        `headKey timed out for peer ${peer.ipAddress}`
      );
      const keyExists = response.headers?.["x-key-exists"];
      if (keyExists === "true" && response.headers?.["x-generation-hash"] === rootHash) {
        console.log(`Peer ${peer.ipAddress} has the correct key and generation hash for key ${key}.`);
        return true;
      } else {
        console.error(`Peer ${peer.ipAddress} does not have the correct key or generation hash.`);
        return false;
      }
    }
  } catch (error: any) {
    console.error(`Error validating peer ${peer.ipAddress}: ${error.message}`);
    return false;
  }
};

/**
 * Select a batch of peers and run validation concurrently, returning the first valid peer
 * @param peers - List of peers to test
 * @param storeId - The store ID
 * @param rootHash - The expected root hash
 * @param key - Optional. The resource key to validate against.
 * @returns The first valid peer or null if none pass
 */
const selectValidPeer = async (peers: PeerInfo[], storeId: string, rootHash: string, key?: string): Promise<PeerInfo | null> => {
  const validationPromises = peers.map(async (peer) => {
    const isValid = await validatePeer(peer, storeId, rootHash, key);
    if (isValid) return peer;
    return null;
  });

  try {
    const firstValidPeer = await Promise.race(validationPromises); // Use Promise.race to get the first valid peer
    return firstValidPeer;
  } catch (error) {
    console.error("No valid peers found in the batch.");
    return null;
  }
};

/**
 * Middleware to proxy requests through cached peers
 */
export const networkRouter = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const { chainName, storeId, rootHash } = req as any;
  const key = req.path.split("/").slice(2).join("/"); // Extract key

  try {
    // Refresh peer list if needed
    await refreshPeerListIfNeeded(storeId);

    // Set up periodic refresh
    setupPeriodicRefresh(storeId);

    let peers = peerCache.get(storeId) as PeerInfo[] | undefined;
    if (!peers || peers.length === 0) {
      res.status(500).send(`No available peers for storeId: ${storeId}.`);
      return;
    }

    let validPeer: PeerInfo | null = null;

    // Try in batches of peers
    while (peers.length > 0 && !validPeer) {
      const batch = peers.splice(0, 5); // Select a batch of up to 5 peers
      validPeer = await selectValidPeer(batch, storeId, rootHash, key);

      if (!validPeer) {
        console.log("No valid peers in this batch. Trying another batch...");
      }
    }

    if (!validPeer) {
      res.status(500).send("No valid peers available.");
      return;
    }

    const peerIp = validPeer.ipAddress;
    activeConnections[peerIp] += 1;

    let contentUrl = `http://${peerIp}:4161/${chainName}.${storeId}.${rootHash}`;
    if (key) {
      contentUrl += `/${key}`;
    }

    console.log(`Proxying request to ${contentUrl}`);

    const targetUrl = new URL(contentUrl);

    const start = Date.now(); // Track latency

    const proxyOptions: Options = {
      target: targetUrl.origin,
      changeOrigin: true,
      pathRewrite: () => `/${chainName}.${storeId}.${rootHash}/${key}`,
      // @ts-ignore
      onError: (err: any) => {
        activeConnections[peerIp] -= 1;
        adjustPeerStats(validPeer!, false, Date.now() - start); // Adjust stats on failure
        console.error(`Peer ${peerIp} failed. Returning error to client.`);
        res.status(500).send("Proxy error");
      },
      onProxyReq: (proxyReq: any) => {
        proxyReq.setHeader("Host", targetUrl.host);
      },
      onProxyRes: () => {
        activeConnections[peerIp] -= 1;
        adjustPeerStats(validPeer!, true, Date.now() - start); // Adjust stats on success
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
