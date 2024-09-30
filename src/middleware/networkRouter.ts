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
const storeRefreshIntervals: { [storeId: string]: NodeJS.Timeout } = {};

/**
 * Enforce a timeout on a promise
 * @param {Promise<T>} promise - The promise to enforce timeout on
 * @param {number} ms - Timeout duration in milliseconds
 * @param {string} timeoutMessage - Message to show on timeout
 * @returns {Promise<T>} - A promise that either resolves or rejects after timeout
 */
const withTimeout = <T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), ms)),
  ]);
};

/**
 * Seed the peer list for a specific storeId, or refresh if necessary
 * @param {string} storeId - The store ID for which peers are seeded
 */
const seedPeerList = async (storeId: string): Promise<void> => {
  try {
    const serverCoin = new ServerCoin(storeId);
    const peersIpAddresses = await serverCoin.sampleCurrentEpoch(50);

    peerCache.set(
      storeId,
      peersIpAddresses.map((ip) => ({
        ipAddress: ip,
        weight: 5,
        failureCount: 0,
        successCount: 0,
        lastCheck: Date.now(),
        lastFailure: 0,
        totalRequests: 0,
        totalLatency: 0,
      }))
    );

    peersIpAddresses.forEach((ip) => (activeConnections[ip] = 0));

    console.log(`Peer list seeded for storeId: ${storeId}`);
  } catch (error: any) {
    console.error(`Failed to seed peer list for storeId ${storeId}: ${error.message}`);
  }
};

/**
 * Refresh peer list for a given storeId if the epoch has changed or peers are exhausted
 * @param {string} storeId - The store ID for which peers should be refreshed
 */
const refreshPeerListIfNeeded = async (storeId: string): Promise<void> => {
  try {
    const newEpoch = ServerCoin.getCurrentEpoch() as EpochData;

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
 * @param {string} storeId - The store ID for which periodic refresh should be set up
 */
const setupPeriodicRefresh = (storeId: string): void => {
  if (storeRefreshIntervals[storeId]) return;

  const interval = setInterval(() => refreshPeerListIfNeeded(storeId), 30 * 60 * 1000);
  storeRefreshIntervals[storeId] = interval;

  console.log(`Periodic refresh set up for storeId: ${storeId}`);
};

/**
 * Adjust peer statistics on success or failure
 * @param {PeerInfo} peer - Peer information object
 * @param {boolean} success - Whether the request was successful
 * @param {number} latency - The latency of the request
 */
const adjustPeerStats = (peer: PeerInfo, success: boolean, latency: number): void => {
  peer.totalRequests += 1;
  peer.totalLatency += latency;

  if (success) {
    peer.successCount += 1;
    peer.weight = Math.min(peer.weight + 1, 10); // Max weight 10
    peer.failureCount = 0;
  } else {
    peer.failureCount += 1;
    peer.weight = Math.max(peer.weight - 1, 1); // Min weight 1
    peer.lastFailure = Date.now();
    if (peer.failureCount >= 3) offlinePeersCache.set(peer.ipAddress, true);
  }

  peer.lastCheck = Date.now();
};

/**
 * Validate if a peer contains the correct root hash or key data
 * @param {PeerInfo} peer - The peer to validate
 * @param {string} storeId - The storeId to test
 * @param {string} rootHash - The expected root hash
 * @param {string} [key] - Optional. The resource key to validate
 * @returns {Promise<boolean>} - Whether the peer is valid or not
 */
const validatePeer = async (peer: PeerInfo, storeId: string, rootHash: string, key?: string): Promise<boolean> => {
  try {
    const digPeer = new DigPeer(peer.ipAddress, storeId);
    const response = key
      ? await withTimeout(digPeer.contentServer.headKey(key, rootHash), 5000, `headKey timed out for peer ${peer.ipAddress}`)
      : await withTimeout(digPeer.contentServer.headStore({ hasRootHash: rootHash }), 5000, `headStore timed out for peer ${peer.ipAddress}`);

    const isValid = key
      ? response.headers?.["x-key-exists"] === "true" && response.headers?.["x-generation-hash"] === rootHash
      : response.headers?.["x-has-roothash"] === "true";

    return isValid;
  } catch (error: any) {
    console.error(`Error validating peer ${peer.ipAddress}: ${error.message}`);
    return false;
  }
};

/**
 * Select the first valid peer from a list of peers
 * @param {PeerInfo[]} peers - List of peers to test
 * @param {string} storeId - The store ID
 * @param {string} rootHash - The expected root hash
 * @param {string} [key] - Optional. The resource key to validate
 * @returns {Promise<PeerInfo | null>} - The first valid peer or null if none are valid
 */
const selectValidPeer = async (peers: PeerInfo[], storeId: string, rootHash: string, key?: string): Promise<PeerInfo | null> => {
  const validationPromises = peers.map((peer) => validatePeer(peer, storeId, rootHash, key).then((isValid) => (isValid ? peer : null)));
  return Promise.race(validationPromises);
};

/**
 * Middleware to proxy requests through cached peers
 */
export const networkRouter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const { chainName, storeId, rootHash } = req as any;
  const key = req.path.split("/").slice(2).join("/");

  try {
    await refreshPeerListIfNeeded(storeId);
    setupPeriodicRefresh(storeId);

    let peers = peerCache.get(storeId) as PeerInfo[] | undefined;
    if (!peers || peers.length === 0) {
      res.status(500).send(`No available peers for storeId: ${storeId}.`);
      return;
    }

    let validPeer: PeerInfo | null = null;
    let peerForKeyFound = false;

    // Try to find a valid peer for the key if provided
    if (key) {
      while (peers.length > 0 && !validPeer) {
        validPeer = await selectValidPeer(peers.splice(0, 5), storeId, rootHash, key);
        if (validPeer) {
          peerForKeyFound = true;
        }
      }
    }

    // If no peer for the key was found, fall back to finding a peer with just the root hash
    if (!peerForKeyFound) {
      peers = peerCache.get(storeId) as PeerInfo[];
      while (peers.length > 0 && !validPeer) {
        validPeer = await selectValidPeer(peers.splice(0, 5), storeId, rootHash);
      }
    }

    if (!validPeer) {
      res.status(500).send("No valid peers available.");
      return;
    }

    const peerIp = validPeer.ipAddress;
    activeConnections[peerIp] += 1;

    // If no peer for the key was found, just use the rootHash URL
    let contentUrl = `http://${peerIp}:4161/${chainName}.${storeId}.${rootHash}`;
    if (peerForKeyFound && key) {
      contentUrl += `/${key}`;
    }

    console.log(`Proxying request to ${contentUrl}`);

    const start = Date.now();

    // Set the X-Peer-Served-By header
    res.setHeader("X-Network-Origin", `DIG Network: ${peerIp}`);

    const proxyOptions: Options = {
      target: `http://${peerIp}:4161`,
      changeOrigin: true,
      pathRewrite: () => `/${chainName}.${storeId}.${rootHash}${peerForKeyFound ? `/${key}` : ""}`,
      // @ts-ignore
      onError: (err: any) => {
        activeConnections[peerIp] -= 1;
        adjustPeerStats(validPeer!, false, Date.now() - start);
        res.status(500).send("Proxy error");
      },
      onProxyReq: (proxyReq: any) => proxyReq.setHeader("Host", `${peerIp}:4161`),
      onProxyRes: () => {
        activeConnections[peerIp] -= 1;
        adjustPeerStats(validPeer!, true, Date.now() - start);
      },
    };

    createProxyMiddleware(proxyOptions)(req, res, next);
  } catch (error: any) {
    res.status(500).send(error.message);
  }
};
