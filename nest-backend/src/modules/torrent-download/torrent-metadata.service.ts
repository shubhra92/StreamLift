import { Injectable, Logger } from '@nestjs/common';
import WebTorrent from 'webtorrent';

// Swallow known webtorrent internal errors that fire after client.destroy()
// These are webtorrent bugs — they cannot be caught normally.
process.on('uncaughtException', (err: Error) => {
  if (
    err instanceof TypeError &&
    err.stack?.includes('webtorrent')
  ) {
    console.error('⚠️  webtorrent internal error (safe to ignore):', err.message);
    return; // swallow — do NOT re-throw
  }
  // Re-throw anything unrelated to webtorrent
  throw err;
});

function formatBytes(bytes: number): string {
  if (!bytes) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function getFileType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma'].includes(ext)) return 'audio';
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp'].includes(ext)) return 'image';
  if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'epub'].includes(ext)) return 'document';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return 'archive';
  return 'other';
}

// Minimal in-memory store that satisfies webtorrent's interface without any disk I/O.
// Used only for metadata fetching — we never actually read back any chunks.
function MemoryStore(chunkLength: number, _opts: any) {
  (this as any).chunkLength = chunkLength;
  (this as any).chunks = new Map<number, Buffer>();
}
(MemoryStore.prototype as any).put = function (
  index: number,
  buf: Buffer,
  cb: (err?: Error | null) => void,
) {
  this.chunks.set(index, buf);
  cb(null);
};
(MemoryStore.prototype as any).get = function (
  index: number,
  opts: any,
  cb: (err: Error | null, buf?: Buffer) => void,
) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const buf = this.chunks.get(index);
  if (!buf) return cb(new Error('chunk not found'));
  const start = opts?.offset ?? 0;
  const end = opts?.length != null ? start + opts.length : buf.length;
  cb(null, buf.slice(start, end));
};
(MemoryStore.prototype as any).close = function (cb: () => void) {
  this.chunks.clear();
  cb();
};
(MemoryStore.prototype as any).destroy = function (cb?: () => void) {
  this.chunks.clear();
  cb?.();
};

@Injectable()
export class TorrentMetadataService {
  private readonly logger = new Logger(TorrentMetadataService.name);

  async getMetadata(magnetLink: string) {
    const client = new WebTorrent();

    client.on('error', (err: Error | string) => {
      const msg = typeof err === 'string' ? err : err.message;
      this.logger.warn('WebTorrent client error: ' + msg);
    });

    let timeoutId: NodeJS.Timeout | null = null;

    const destroyClient = () => {
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      // Delay so any in-flight webtorrent callbacks don't hit a destroyed client
      setTimeout(() => { try { client.destroy(); } catch (_) {} }, 500);
    };

    try {
      const metadata = await new Promise<any>((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error('TIMEOUT')), 30_000);

        // Use our MemoryStore — avoids any disk I/O and the fs-chunk-store constructor error
        const handle = client.add(
          magnetLink,
          { store: MemoryStore, skipVerify: true } as any,
          (torrent: any) => {
            try {
              if (!torrent.files?.length) {
                return reject(new Error('Torrent has no files'));
              }

              const files = torrent.files
                .map((f: any, index: number) => ({
                  index,
                  name: f.name,
                  path: f.path,
                  size: f.length,
                  sizeFormatted: formatBytes(f.length),
                  type: getFileType(f.name),
                }))
                .sort((a: any, b: any) => b.size - a.size);

              this.logger.log(
                `Metadata fetched: ${torrent.name} (${files.length} files)`,
              );

              resolve({
                name: torrent.name,
                infoHash: torrent.infoHash,
                totalSize: torrent.length,
                totalSizeFormatted: formatBytes(torrent.length),
                files,
                fileCount: files.length,
              });
            } catch (err) {
              reject(err);
            }
          },
        );

        (handle as any).on('error', (err: Error) => reject(err));
      });

      destroyClient();
      return metadata;
    } catch (err: any) {
      destroyClient();
      throw err;
    }
  }
}
