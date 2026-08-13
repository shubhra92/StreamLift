/**
 * Cloud provider router.
 *
 * Reads the STORAGE_PROVIDER env variable at runtime and returns the
 * correct upload helpers so the rest of the codebase stays provider-agnostic.
 *
 * Supported values:
 *   STORAGE_PROVIDER=mega   (default)
 *
 * Adding a new provider:
 *   1. Create src/utils/providers/<name>/ with streamUrlTo<Name>.js and
 *      streamTorrentTo<Name>.js that export `streamUrlToCloud` and
 *      `streamTorrentToCloud` respectively.
 *   2. Add a case for it in getCloudProvider() below.
 *   3. Set STORAGE_PROVIDER=<name> in your .env.
 */

const SUPPORTED_PROVIDERS = ["mega"];

function getCloudProvider() {
  const provider = (process.env.STORAGE_PROVIDER ?? "mega").toLowerCase();

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new Error(
      `Unsupported STORAGE_PROVIDER "${provider}". ` +
      `Supported values: ${SUPPORTED_PROVIDERS.join(", ")}`
    );
  }

  return provider;
}

/**
 * Returns { streamUrlToCloud, streamTorrentToCloud } for the configured provider.
 * Imported lazily so modules are only loaded when actually needed.
 */
export async function getCloudUploadFns() {
  const provider = getCloudProvider();

  switch (provider) {
    case "mega": {
      const { streamUrlToMega } = await import("./providers/mega/streamUrlToMega.js");
      const { streamTorrentToMega } = await import("./providers/mega/streamTorrentToMega.js");
      return {
        streamUrlToCloud: streamUrlToMega,
        streamTorrentToCloud: streamTorrentToMega,
      };
    }

    // Future example:
    // case "s3": {
    //   const { streamUrlToS3 } = await import("./providers/s3/streamUrlToS3.js");
    //   const { streamTorrentToS3 } = await import("./providers/s3/streamTorrentToS3.js");
    //   return {
    //     streamUrlToCloud: streamUrlToS3,
    //     streamTorrentToCloud: streamTorrentToS3,
    //   };
    // }

    default:
      throw new Error(`No implementation registered for provider "${provider}"`);
  }
}

export { getCloudProvider };
