/**
 * Shared Watch-item types.
 *
 * These are deliberately provider-agnostic. `provider` identifies the storage
 * backend and `playbackMode` tells the player how to consume `sourceUrl`:
 *   mega + mega-share -> megajs range decryption in the service worker
 *   future s3 + direct -> plain range fetch
 */

export type WatchKind = "video" | "audio";

export interface WatchItemDto {
  id: string;
  provider: string;
  providerItemId: string | null;
  name: string;
  fileSize: number | null;
  kind: WatchKind;
  mimeType: string | null;
  sourceUrl: string;
  playbackMode: string;
  sourceDownloadId: string | null;
  createdAt: string | null;
}
