import { Request, Response, NextFunction } from "express";
import { createProxyMiddleware, Options } from "http-proxy-middleware";
import NodeCache from "node-cache";
import { ServerCoin, DigPeer, withTimeout } from "@dignetwork/dig-sdk";

// Caches and tracking variables
const peerCache = new NodeCache({ stdTTL: 600 });
const offlinePeersCache = new NodeCache({ stdTTL: 300 });
const activeConnections: { [peerIp: string]: number } = {};
const preferredPeers: { [storeId: string]: PeerInfo | null } = {};
const backupPeers: { [storeId: string]: PeerInfo[] } = {};

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
  totalLatency: number;
  totalBytes: number;
}

let currentEpoch: EpochData | null = null;
const storeRefreshIntervals: { [storeId: string]: NodeJS.Timeout } = {};

/**
 * Seeds the peer list for a specific storeId.
 */
const seedPeerList = async (storeId: string): Promise<void> => {
  try {
    const serverCoin = new ServerCoin(storeId);
    const peersIpAddresses = await serverCoin.sampleCurrentEpoch(50);

    const peers = peersIpAddresses.map((ip) => ({
      ipAddress: ip,
      weight: 5,
      failureCount: 0,
      successCount: 0,
      lastCheck: Date.now(),
      lastFailure: 0,
      totalRequests: 0,
      totalLatency: 0,
      totalBytes: 0,
    }));

    peerCache.set(storeId, peers);
    peersIpAddresses.forEach((ip) => (activeConnections[ip] = 0));

    console.log(`Peer list seeded for storeId: ${storeId}`);
  } catch (error: any) {
    console.error(`Failed to seed peer list for storeId ${storeId}: ${error.message}`);
  }
};

/**
 * Refreshes the peer list if needed.
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
 * Sets up periodic peer list refresh.
 */
const setupPeriodicRefresh = (storeId: string): void => {
  if (storeRefreshIntervals[storeId]) return;

  storeRefreshIntervals[storeId] = setInterval(() => refreshPeerListIfNeeded(storeId), 30 * 60 * 1000);

  console.log(`Periodic refresh set up for storeId: ${storeId}`);
};

/**
 * Adjusts peer statistics based on the request outcome.
 */
const adjustPeerStats = (peer: PeerInfo, success: boolean, latency: number, bytes: number): void => {
  peer.totalRequests += 1;
  peer.totalLatency += latency;
  peer.totalBytes += bytes;

  if (success) {
    peer.successCount += 1;
    peer.weight = Math.min(peer.weight + 1, 10);
    peer.failureCount = 0;
  } else {
    peer.failureCount += 1;
    peer.weight = Math.max(peer.weight - 1, 1);
    peer.lastFailure = Date.now();

    if (peer.failureCount >= 3) offlinePeersCache.set(peer.ipAddress, true);
  }

  peer.lastCheck = Date.now();
};

/**
 * Normalizes latency by factoring in bytes transferred.
 */
const calculateNormalizedLatency = (peer: PeerInfo): number => {
  const avgLatency = peer.totalLatency / Math.max(peer.totalRequests, 1);
  const avgBytes = peer.totalBytes / Math.max(peer.totalRequests, 1);
  return avgLatency / Math.max(avgBytes, 1);
};

/**
 * Validates if a peer is ready with the required content.
 */
const validatePeer = async (peer: PeerInfo, storeId: string, rootHash: string): Promise<boolean> => {
  try {
    const digPeer = new DigPeer(peer.ipAddress, storeId);
    const response = await withTimeout(digPeer.contentServer.headStore({ hasRootHash: rootHash }), 5000, `Validation timeout for ${peer.ipAddress}`);
    return response.headers?.["x-has-roothash"] === "true";
  } catch {
    return false;
  }
};

/**
 * Switches to a valid peer and updates the backup list.
 */
const switchPreferredPeer = async (storeId: string, rootHash: string): Promise<void> => {
  const peers = peerCache.get<PeerInfo[]>(storeId) || [];
  for (const peer of peers) {
    if (await validatePeer(peer, storeId, rootHash)) {
      preferredPeers[storeId] = peer;
      backupPeers[storeId] = getBackupPeers(storeId, [peer.ipAddress]);
      return;
    }
  }
  preferredPeers[storeId] = null;
};

/**
 * Retrieves two backup peers excluding certain IPs.
 */
const getBackupPeers = (storeId: string, exclude: string[]): PeerInfo[] => {
  const peers = peerCache.get<PeerInfo[]>(storeId) || [];
  return peers.filter((peer) => !exclude.includes(peer.ipAddress)).slice(0, 2);
};

/**
 * Express middleware to proxy requests through preferred or backup peers.
 */
export const networkRouter = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const { storeId, rootHash } = req as any;
  const key = req.path.split("/").slice(2).join("/");

  try {
    await refreshPeerListIfNeeded(storeId);
    setupPeriodicRefresh(storeId);

    let peer = preferredPeers[storeId];
    if (!peer) {
      await switchPreferredPeer(storeId, rootHash);
      peer = preferredPeers[storeId];

      if (!peer) {
        res.status(500).send(`No valid peers available for storeId: ${storeId}.`);
        return;
      }
    }

    // Randomly validate backup peers with a 20% chance
    if (Math.random() < 0.2) {
      const backup = backupPeers[storeId];
      if (backup.length > 0) await validatePeer(backup[0], storeId, rootHash);
    }

    const peerIp = peer.ipAddress;
    activeConnections[peerIp] += 1;

    const start = Date.now();
    let bytesTransferred = 0;

    res.setHeader("X-Network-Origin", `DIG Network: ${peerIp}`);

    const proxyOptions: Options = {
      target: `http://${peerIp}:4161`,
      changeOrigin: true,
      pathRewrite: () => `/${storeId}/${rootHash}${key ? `/${key}` : ""}`,
      // @ts-ignore
      onError: async () => {
        const latency = Date.now() - start;
        activeConnections[peerIp] -= 1;
        adjustPeerStats(peer!, false, latency, bytesTransferred);
        if (backupPeers[storeId].length > 0) preferredPeers[storeId] = backupPeers[storeId].shift()!;
        res.status(500).send("Proxy error");
      },
      onProxyRes: (proxyRes: any) => {
        proxyRes.on('data', (chunk: any) => bytesTransferred += chunk.length);
        proxyRes.on('end', () => {
          const latency = Date.now() - start;
          activeConnections[peerIp] -= 1;
          adjustPeerStats(peer!, true, latency, bytesTransferred);
        });
      },
    };

    createProxyMiddleware(proxyOptions)(req, res, next);
  } catch (error: any) {
    res.status(500).send(error.message);
  }
};
