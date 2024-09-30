import { Request, Response, NextFunction } from "express";
import { renderUnknownChainView } from "../views";
import { DataStore } from "@dignetwork/dig-sdk";

const validChainNames = ["chia"]; // List of valid chain names

function removeDuplicatePathPart(path: string): string {
  const parts = path.split('/').filter(part => part.length > 0);
  if (parts.length >= 2) {
    const firstPart = parts[0];
    const secondPart = parts[1];
    if (firstPart === secondPart && firstPart.length >= 64) {
      parts.splice(1, 1);
    }
  }
  return '/' + parts.join('/');
}

export const parseUdi = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    if (req.originalUrl.startsWith("/.well-known")) {
      return next();
    }

    const [path, queryString] = req.originalUrl.split("?");
    const modifiedPath = removeDuplicatePathPart(path);
    const modifiedUrl = queryString ? `${modifiedPath}?${queryString}` : modifiedPath;

    const referrer = req.get("Referer") || "";
    let cookieData = req.cookies.udiData || null;

    let chainName: string | null = null;
    let storeId: string = "";
    let rootHash: string | null = null;

    const pathSegments = modifiedPath.split("/").filter(segment => segment.length > 0);
    const pathSegment = pathSegments[0] || "";
    const originalPathSegments = pathSegments.slice(1);
    let appendPath = originalPathSegments.length > 0 ? `/${originalPathSegments.join("/")}` : "";

    const parts = pathSegment.split(".");
    if (parts.length === 1 && parts[0].length !== 64) {
      appendPath = `/${parts[0]}${appendPath}`;
    }

    if (parts.length === 3) {
      chainName = parts[0];
      storeId = parts[1];
      rootHash = parts[2];
    } else if (parts.length === 2) {
      if (parts[0].length === 64) {
        storeId = parts[0];
        rootHash = parts[1];
      } else {
        chainName = parts[0];
        storeId = parts[1];
      }
    } else if (parts.length === 1) {
      storeId = parts[0];
    }

    console.log("Extracted values - Chain Name:", chainName, "Store ID:", storeId, "Root Hash:", rootHash);

    const isCloudFrontRequest = req.headers['x-amz-cf-id'] !== undefined;
    const host = req.get('host'); // Get the host (CloudFront domain if CloudFront is the origin)

    if (!storeId || storeId.length !== 64) {
      if (cookieData) {
        const { chainName: cookieChainName, storeId: cookieStoreId } = cookieData;
        console.warn("Invalid storeId, redirecting to referrer:", referrer);
        const redirectUrl = isCloudFrontRequest
          ? `https://${host}/${cookieChainName}.${cookieStoreId}${appendPath}`
          : `/${cookieChainName}.${cookieStoreId}${appendPath}`;
        return res.redirect(302, redirectUrl);
      }
      if (referrer) {
        console.warn("Invalid storeId, redirecting to referrer:", referrer);
        const redirectUrl = isCloudFrontRequest
          ? `https://${host}${referrer}${appendPath}`
          : `${referrer}${appendPath}`;
        return res.redirect(302, redirectUrl);
      }
      return res.status(400).send("Invalid or missing storeId.");
    }

    if (!chainName || !rootHash) {
      if (cookieData) {
        const {
          chainName: cookieChainName,
          storeId: cookieStoreId,
          rootHash: cookieRootHash,
        } = cookieData;
        if (!storeId || cookieStoreId === storeId || cookieRootHash === rootHash) {
          chainName = chainName || cookieChainName;
          rootHash = rootHash || cookieRootHash;
        } else {
          console.log("StoreId changed, ignoring cookie data.");
        }
      }
    }

    const dataStore = DataStore.from(storeId);

    if (!chainName && !rootHash) {
      const storeInfo = await dataStore.fetchCoinInfo();
      rootHash = storeInfo.latestStore.metadata.rootHash.toString("hex");

      // If CloudFront is the requester, redirect to the CloudFront domain
      const redirectUrl = isCloudFrontRequest
        ? `https://${host}/chia.${storeId}.${rootHash}${appendPath}${queryString ? '?' + queryString : ''}`
        : `/chia.${storeId}.${rootHash}${appendPath}${queryString ? '?' + queryString : ''}`;
      console.log("Redirecting to:", redirectUrl);
      return res.redirect(302, redirectUrl);
    }

    if (!chainName) {
      const redirectUrl = isCloudFrontRequest
        ? `https://${host}/chia.${pathSegment}${appendPath}${queryString ? '?' + queryString : ''}`
        : `/chia.${pathSegment}${appendPath}${queryString ? '?' + queryString : ''}`;
      console.log("ChainName missing, redirecting to:", redirectUrl);
      return res.redirect(302, redirectUrl);
    }

    if (!validChainNames.includes(chainName)) {
      console.warn("Invalid chain name:", chainName);
      return res.status(400).send(renderUnknownChainView(storeId, chainName));
    }

    if (!rootHash) {
      const storeInfo = await dataStore.fetchCoinInfo();
      rootHash = storeInfo.latestStore.metadata.rootHash.toString("hex");
    }

    // Handle CloudFront request-specific logic
    if (isCloudFrontRequest) {
      console.log("Request from CloudFront, modifying redirect.");
      const cloudfrontRedirect = `https://${host}/${chainName}.${storeId}.${rootHash}${appendPath}${queryString ? '?' + queryString : ''}`;
      return res.redirect(302, cloudfrontRedirect);
    }

    // Attach extracted components to the request object
    // @ts-ignore
    req.chainName = chainName;
    // @ts-ignore
    req.storeId = storeId;
    // @ts-ignore
    req.rootHash = rootHash;

    res.cookie(
      "udiData",
      { chainName, storeId, rootHash },
      {
        httpOnly: true,
        secure: false,
        maxAge: 5 * 60 * 1000,
        expires: new Date(Date.now() + 5 * 60 * 1000),
      }
    );

    next();
  } catch (error) {
    console.error("Error in parseUdi middleware:", error);
    res.status(500).send("An error occurred while verifying the identifier.");
  }
};
