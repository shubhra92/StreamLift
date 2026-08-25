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
 *   1. Create src/utils/providers/<name>/ with streamUrlTo<Name>.ts and
 *      streamTorrentTo<Name>.ts that export `streamUrlToCloud` and
 *      `streamTorrentToCloud` respectively.
 *   2. Add a case for it in getCloudProvider() below.
 *   3. Set STORAGE_PROVIDER=<name> in your .env.
 */

const SUPPORTED_PROVIDERS = ['mega'] as const;

type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

function getCloudProvider(): ProviderName {
  const provider = (process.env.STORAGE_PROVIDER ?? 'mega').toLowerCase() as ProviderName;

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new Error(
      `Unsupported STORAGE_PROVIDER "${provider}". ` +
      `Supported values: ${SUPPORTED_PROVIDERS.join(', ')}`
    );
  }

  return provider;
}

export interface CloudUploadFns {
  streamUrlToCloud: (
    id: string,
    url: string,
    options: { fileName?: string | null; guestId?: string | null },
    megaInstance: any
  ) => Promise<void>;
  streamTorrentToCloud: (
    id: string,
    magnetLink: string,
    options: { fileName?: string | null; fileIndices?: number[] | null; guestId?: string | null },
    megaInstance: any
  ) => Promise<void>;
}

/**
 * Returns { streamUrlToCloud, streamTorrentToCloud } for the configured provider.
 * Imported lazily so modules are only loaded when actually needed.
 */
export async function getCloudUploadFns(): Promise<CloudUploadFns> {
  const provider = getCloudProvider();

  switch (provider) {
    case 'mega': {
      const { streamUrlToMega } = await import('./providers/mega/stream-url-to-mega.js');
      const { streamTorrentToMega } = await import('./providers/mega/stream-torrent-to-mega.js');
      return {
        streamUrlToCloud: streamUrlToMega,
        streamTorrentToCloud: streamTorrentToMega,
      };
    }

    // Future example:
    // case 's3': {
    //   const { streamUrlToS3 } = await import('../providers/s3/stream-url-to-s3');
    //   const { streamTorrentToS3 } = await import('../providers/s3/stream-torrent-to-s3');
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