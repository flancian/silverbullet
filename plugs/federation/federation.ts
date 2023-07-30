import "$sb/lib/fetch.ts";
import type { FileMeta } from "../../common/types.ts";
import { federatedPathToUrl } from "$sb/lib/resolve.ts";
import { readFederationConfigs } from "./config.ts";
import { store } from "$sb/plugos-syscall/mod.ts";

async function responseToFileMeta(
  r: Response,
  name: string,
): Promise<FileMeta> {
  const federationConfigs = await readFederationConfigs();

  // Default permission is "ro" unless explicitly set otherwise
  let perm: "ro" | "rw" = "ro";
  const federationConfig = federationConfigs.find((config) =>
    name.startsWith(config.uri)
  );
  if (federationConfig?.perm) {
    perm = federationConfig.perm;
  }
  return {
    name: name,
    size: r.headers.get("Content-length")
      ? +r.headers.get("Content-length")!
      : 0,
    contentType: r.headers.get("Content-type")!,
    perm,
    lastModified: +(r.headers.get("X-Last-Modified") || "0"),
  };
}

const fileListingPrefixCacheKey = `federationListCache:`;
const listingCacheTimeout = 1000 * 30;

type FileListingCacheEntry = {
  items: FileMeta[];
  lastUpdated: number;
};

export async function listFiles(): Promise<FileMeta[]> {
  let fileMetas: FileMeta[] = [];
  // Fetch them all in parallel
  try {
    await Promise.all((await readFederationConfigs()).map(async (config) => {
      const cachedListing = await store.get(
        `${fileListingPrefixCacheKey}${config.uri}`,
      ) as FileListingCacheEntry;
      if (
        cachedListing &&
        cachedListing.lastUpdated > Date.now() - listingCacheTimeout
      ) {
        fileMetas = fileMetas.concat(cachedListing.items);
        return;
      }
      console.log("Fetching from federated", config);
      const uriParts = config.uri.split("/");
      const rootUri = uriParts[0];
      const prefix = uriParts.slice(1).join("/");
      const indexUrl = `${federatedPathToUrl(rootUri)}/index.json`;
      try {
        const r = await nativeFetch(indexUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
          },
        });
        if (r.status !== 200) {
          console.error(
            `Failed to fetch ${indexUrl}. Skipping.`,
            r.status,
            r.statusText,
          );
          if (cachedListing) {
            console.info("Using cached listing");
            fileMetas = fileMetas.concat(cachedListing.items);
          }
          return;
        }
        const jsonResult = await r.json();
        const items: FileMeta[] = jsonResult.filter((meta: FileMeta) =>
          meta.name.startsWith(prefix)
        ).map((meta: FileMeta) => ({
          ...meta,
          perm: config.perm || "ro",
          name: `${rootUri}/${meta.name}`,
        }));
        await store.set(`${fileListingPrefixCacheKey}${config.uri}`, {
          items,
          lastUpdated: Date.now(),
        } as FileListingCacheEntry);
        fileMetas = fileMetas.concat(items);
      } catch (e: any) {
        console.error("Failed to process", indexUrl, e);
      }
    }));

    // console.log("All of em: ", fileMetas);
    return fileMetas;
  } catch (e: any) {
    console.error("Error listing federation files", e);
    return [];
  }
}

export async function readFile(
  name: string,
): Promise<{ data: Uint8Array; meta: FileMeta } | undefined> {
  const url = federatedPathToUrl(name);
  const r = await nativeFetch(url);
  if (r.status === 503) {
    throw new Error("Offline");
  }
  const fileMeta = await responseToFileMeta(r, name);
  console.log("Fetching", url);
  if (r.status === 404) {
    throw Error("Not found");
  }
  const data = await r.arrayBuffer();
  if (!r.ok) {
    return errorResult(name, `**Error**: Could not load`);
  }

  return {
    data: new Uint8Array(data),
    meta: fileMeta,
  };
}

function errorResult(
  name: string,
  error: string,
): { data: Uint8Array; meta: FileMeta } {
  return {
    data: new TextEncoder().encode(error),
    meta: {
      name,
      contentType: "text/markdown",
      lastModified: 0,
      size: 0,
      perm: "ro",
    },
  };
}

export async function writeFile(
  name: string,
  data: Uint8Array,
): Promise<FileMeta> {
  throw new Error("Writing federation file, not yet supported");
  // const url = resolveFederated(name);
  // console.log("Writing federation file", url);

  // const r = await nativeFetch(url, {
  //   method: "PUT",
  //   body: data,
  // });
  // const fileMeta = await responseToFileMeta(r, name);
  // if (!r.ok) {
  //   throw new Error("Could not write file");
  // }

  // return fileMeta;
}

export async function deleteFile(
  name: string,
): Promise<void> {
  throw new Error("Writing federation file, not yet supported");

  // console.log("Deleting federation file", name);
  // const url = resolveFederated(name);
  // const r = await nativeFetch(url, { method: "DELETE" });
  // if (!r.ok) {
  //   throw Error("Failed to delete file");
  // }
}

export async function getFileMeta(name: string): Promise<FileMeta> {
  const url = federatedPathToUrl(name);
  console.log("Fetching federation file meta", url);
  const r = await nativeFetch(url, { method: "HEAD" });
  if (r.status === 503) {
    throw new Error("Offline");
  }
  const fileMeta = await responseToFileMeta(r, name);
  if (!r.ok) {
    throw new Error("Not found");
  }
  return fileMeta;
}
