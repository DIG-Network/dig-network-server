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
 * Seed the peer list for a specific storeId, or refresh if necessary
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
    console.error(
      `Failed to seed peer list for storeId ${storeId}: ${error.message}`
    );
  }
};

/**
 * Refresh peer list for a given storeId if the epoch has changed or peers are exhausted
 */
const refreshPeerListIfNeeded = async (storeId: string): Promise<void> => {
  try {
    const newEpoch = ServerCoin.getCurrentEpoch() as EpochData;

    if (
      !currentEpoch ||
      newEpoch.epoch !== currentEpoch.epoch ||
      newEpoch.round !== currentEpoch.round ||
      !peerCache.has(storeId)
    ) {
      console.log(
        `Epoch changed or peer list exhausted for storeId ${storeId}. Refreshing peer list...`
      );
      currentEpoch = newEpoch;
      await seedPeerList(storeId);
    }
  } catch (error: any) {
    console.error(
      `Error refreshing peer list for storeId ${storeId}: ${error.message}`
    );
  }
};

/**
 * Set up periodic refresh for a specific storeId's peer list
 */
const setupPeriodicRefresh = (storeId: string): void => {
  if (storeRefreshIntervals[storeId]) return;

  const interval = setInterval(
    () => refreshPeerListIfNeeded(storeId),
    30 * 60 * 1000
  );
  storeRefreshIntervals[storeId] = interval;

  console.log(`Periodic refresh set up for storeId: ${storeId}`);
};

/**
 * Adjust peer statistics on success or failure
 */
const adjustPeerStats = (
  peer: PeerInfo,
  success: boolean,
  latency: number
): void => {
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
 * Weighted Random selection for peers
 */
const getWeightedRandomPeer = (peers: PeerInfo[]): PeerInfo => {
  const totalWeight = peers.reduce((sum, peer) => sum + peer.weight, 0);
  let randomWeight = Math.random() * totalWeight;

  for (const peer of peers) {
    randomWeight -= peer.weight;
    if (randomWeight <= 0) {
      return peer;
    }
  }

  return peers[0]; // Fallback to first peer if none selected
};

/**
 * Least Connections selection
 */
const getLeastConnectionsPeer = (peers: PeerInfo[]): PeerInfo => {
  const availablePeers = peers.filter(
    (peer) => activeConnections[peer.ipAddress] !== undefined
  );
  return availablePeers.reduce((minPeer, peer) =>
    activeConnections[peer.ipAddress] < activeConnections[minPeer.ipAddress]
      ? peer
      : minPeer
  );
};

/**
 * Latency Aware selection (based on average latency)
 */
const getLowestLatencyPeer = (peers: PeerInfo[]): PeerInfo => {
  return peers.reduce((bestPeer, peer) => {
    const avgLatency =
      peer.totalRequests > 0
        ? peer.totalLatency / peer.totalRequests
        : Infinity;
    const bestLatency =
      bestPeer.totalRequests > 0
        ? bestPeer.totalLatency / bestPeer.totalRequests
        : Infinity;
    return avgLatency < bestLatency ? peer : bestPeer;
  });
};

/**
 * Success Rate-Based selection (Adaptive Load Balancing)
 */
const getBestSuccessRatePeer = (peers: PeerInfo[]): PeerInfo => {
  return peers.reduce((bestPeer, peer) => {
    const successRate =
      peer.totalRequests > 0 ? peer.successCount / peer.totalRequests : 0;
    const bestSuccessRate =
      bestPeer.totalRequests > 0
        ? bestPeer.successCount / bestPeer.totalRequests
        : 0;
    return successRate > bestSuccessRate ? peer : bestPeer;
  });
};

/**
 * Validate if a peer contains the correct root hash or key data
 */
const validatePeer = async (
  peer: PeerInfo,
  storeId: string,
  rootHash: string,
  key?: string
): Promise<boolean> => {
  try {
    const digPeer = new DigPeer(peer.ipAddress, storeId);
    const response = key
      ? await withTimeout(
          digPeer.contentServer.headKey(key, rootHash),
          5000,
          `headKey timed out for peer ${peer.ipAddress}`
        )
      : await withTimeout(
          digPeer.contentServer.headStore({ hasRootHash: rootHash }),
          5000,
          `headStore timed out for peer ${peer.ipAddress}`
        );

    const isValid = key
      ? response.headers?.["x-key-exists"] === "true" &&
        response.headers?.["x-generation-hash"] === rootHash
      : response.headers?.["x-has-roothash"] === "true";

    return isValid;
  } catch (error: any) {
    console.error(`Error validating peer ${peer.ipAddress}: ${error.message}`);
    return false;
  }
};

/**
 * Select the first valid peer from a list of peers
 */
const isValidPeer = async (
  peers: PeerInfo[],
  storeId: string,
  rootHash: string,
  key?: string
): Promise<PeerInfo | null> => {
  const validationPromises = peers.map((peer) =>
    validatePeer(peer, storeId, rootHash, key).then((isValid) =>
      isValid ? peer : null
    )
  );
  return Promise.race(validationPromises);
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
  const key = req.path.split("/").slice(2).join("/");

  try {
    await refreshPeerListIfNeeded(storeId);
    setupPeriodicRefresh(storeId);

    let peers = peerCache.get(storeId) as PeerInfo[] | undefined;
    if (!peers || peers.length === 0) {
      res.status(500).send(`No available peers for storeId: ${storeId}.`);
      return;
    }

    // Keep track of tried peers
    const triedPeers = new Set<string>();

    let peer: PeerInfo | null = null;

    // Attempt to select a valid peer until we run out of peers
    while (peers.length > triedPeers.size) {
      // Select peer using a combination of weighted random, least connections, latency-aware, and success rate
      peer = getWeightedRandomPeer(peers); // Start with weighted random
      if (Math.random() < 0.5) peer = getLeastConnectionsPeer(peers); // Occasionally switch to least-connections
      if (Math.random() < 0.5) peer = getLowestLatencyPeer(peers); // Occasionally prioritize lowest latency
      if (Math.random() < 0.5) peer = getBestSuccessRatePeer(peers); // Occasionally prioritize success rate

      // Check if we've already tried this peer
      if (triedPeers.has(peer.ipAddress)) {
        continue; // Skip to next iteration
      }

      // Validate the selected peer
      const isValid = await isValidPeer([peer], storeId, rootHash);

      if (isValid) {
        break; // Found a valid peer
      } else {
        triedPeers.add(peer.ipAddress); // Mark this peer as tried
        peer = null; // Reset peer to null to indicate invalid peer
      }
    }

    if (!peer) {
      res.status(500).send(`No valid peers available for storeId: ${storeId}.`);
      return;
    }

    const peerIp = peer.ipAddress;
    activeConnections[peerIp] += 1;

    let contentUrl = `http://${peerIp}:4161/${chainName}.${storeId}.${rootHash}`;
    if (key) {
      contentUrl += `/${key}`;
    }

    console.log(`Proxying request to ${contentUrl}`);

    // Set the X-Peer-Served-By header
    res.setHeader("X-Network-Origin", `DIG Network: ${peerIp}`);
    // Set Cache-Control header with max-age of 1 day (86400 seconds)
    res.setHeader("Cache-Control", "public, max-age=86400");


    const start = Date.now();

    const proxyOptions: Options = {
      target: `http://${peerIp}:4161`,
      changeOrigin: true,
      pathRewrite: () =>
        `/${chainName}.${storeId}.${rootHash}${key ? `/${key}` : ""}`,
      // @ts-ignore
      onError: (err: any) => {
        activeConnections[peerIp] -= 1;
        adjustPeerStats(peer, false, Date.now() - start);
        res.status(500).send("Proxy error");
      },
      onProxyReq: (proxyReq: any) =>
        proxyReq.setHeader("Host", `${peerIp}:4161`),
      onProxyRes: () => {
        activeConnections[peerIp] -= 1;
        adjustPeerStats(peer, true, Date.now() - start);
      },
    };

    createProxyMiddleware(proxyOptions)(req, res, next);
  } catch (error: any) {
    res.status(500).send(error.message);
  }
};
