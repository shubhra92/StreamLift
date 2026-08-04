import { Injectable, Logger } from '@nestjs/common';
import WebTorrent from 'webtorrent';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Transform } from 'stream';
import { db, fileDownloads } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { progressMap } from '../../common/progress.store.js';
import { MegaService } from '../mega/mega.service.js';

// ── In-memory chunk store ────────────────────────────────────────────────────
// webtorrent calls `new this._store(chunkLength, opts)` internally.
// Must be a plain constructor function (not a class) so the reference survives
// being stored on the options object and called with `new`.

function MemoryChunkStore(this: any, chunkLength: number, _opts: any) {
  this.chunkLength = chunkLength;
  this.chunks = new Map<number, Buffer>();
}

MemoryChunkStore.prototype.put = function (
  index: number,
  buf: Buffer,
  cb: (err?: Error | null) => void,
) {
  this.chunks.set(index, Buffer.from(buf));
  cb(null);
};

MemoryChunkStore.prototype.get = function (
  index: number,
  opts: any,
  cb: (err: Error | null, buf?: Buffer) => void,
) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const buf = this.chunks.get(index) as Buffer | undefined;
  if (!buf) return cb(new Error('chunk not found'));
  const start = opts?.offset ?? 0;
  const end = opts?.length != null ? start + opts.length : buf.length;
  cb(null, buf.slice(start, end));
};

MemoryChunkStore.prototype.evict = function (index: number) {
  this.chunks.delete(index);
};

MemoryChunkStore.prototype.close = function (cb: () => void) {
  this.chunks.clear();
  cb?.();
};

MemoryChunkStore.prototype.destroy = function (cb?: () => void) {
  this.chunks.clear();
  cb?.();
};

// ── Shared WebTorrent client options ────────────────────────────────────────

function makeTorrentClient(opts: Record<string, any> = {}) {
  return new WebTorrent({
    dht: false,
    utp: false,
    natUpnp: false,
    natPmp: false,
    lsd: false,
    ...opts,
  } as any);
}

const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.moeking.me:6969/announce',
];

@Injectable()
export class TorrentDownloadService {
  private readonly logger = new Logger(TorrentDownloadService.name);
  private readonly serverEnabled =
    process.env.SERVER_DOWNLOAD_ENABLED === 'true';

  constructor(private readonly megaService: MegaService) {}

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async markFailed(id: string, message: string) {
    await db
      .update(fileDownloads)
      .set({ status: 'failed', errorMessage: message, updatedAt: new Date() })
      .where(eq(fileDownloads.id, id));
    progressMap.set(id, {
      downloadedBytes: null,
      totalBytes: null,
      percentFixed2: null,
      percent: null,
      done: true,
    });
  }

  private selectFiles(torrent: any, fileIndices?: number[] | null): any[] {
    // Deselect everything first
    torrent.deselect(0, torrent.pieces.length - 1, 0);
    torrent.files.forEach((f: any) => f.deselect());

    if (fileIndices?.length) {
      const selected = fileIndices
        .map((i) => torrent.files[i])
        .filter(Boolean);
      selected.forEach((f: any) => f.select());
      this.logger.log(`Selected ${selected.length} files by index`);
      return selected;
    }

    const largest = torrent.files.reduce((a: any, b: any) =>
      b.length > a.length ? b : a,
    );
    largest.select();
    this.logger.log(`Auto-selected largest file: ${largest.name}`);
    return [largest];
  }

  // ── Download torrent → local disk ───────────────────────────────────────────

  async downloadToServer(
    id: string,
    magnetLink: string,
    options: {
      fileName?: string | null;
      fileIndices?: number[] | null;
      guestId?: string | null;
    } = {},
  ) {
    if (!this.serverEnabled) {
      await this.markFailed(id, 'server download not available');
      return;
    }

    const downloadDir = options.guestId
      ? join(process.cwd(), 'downloads', options.guestId)
      : join(process.cwd(), 'downloads');

    if (!existsSync(downloadDir)) mkdirSync(downloadDir, { recursive: true });

    const client = makeTorrentClient();

    return new Promise<void>((resolve, reject) => {
      let progressInterval: NodeJS.Timeout | null = null;
      let torrentRef: any = null;
      let done = false;

      const cleanup = async (status: string, errMsg?: string) => {
        if (done) return;
        done = true;
        if (progressInterval) clearInterval(progressInterval);
        process.nextTick(() => {
          try { torrentRef?.destroy({ destroyStore: false }); } catch (_) {}
        });
        await db
          .update(fileDownloads)
          .set({ status, errorMessage: errMsg ?? null, updatedAt: new Date() })
          .where(eq(fileDownloads.id, id));
        progressMap.set(id, {
          downloadedBytes: null,
          totalBytes: null,
          percentFixed2: null,
          percent: null,
          done: true,
        });
      };

      // Use MemoryChunkStore even for disk downloads — avoids the constructor
      // crash. webtorrent will still honour `path` for where it writes files.
      client.add(
        magnetLink,
        {
          path: downloadDir,
          store: MemoryChunkStore,
          announce: PUBLIC_TRACKERS,
        } as any,
        async (torrent: any) => {
          torrentRef = torrent;

          if (!torrent.files?.length) {
            await new Promise((r) => torrent.once('ready', r));
          }

          const selectedFiles = this.selectFiles(torrent, options.fileIndices);
          const totalBytes = selectedFiles.reduce(
            (s: number, f: any) => s + f.length,
            0,
          );
          const displayName =
            options.fileName ??
            (selectedFiles.length === 1
              ? selectedFiles[0].name
              : torrent.name);
          const ext =
            selectedFiles.length === 1
              ? (selectedFiles[0].name.split('.').pop() ?? 'unknown')
              : 'mixed';
          const locationPath = join(downloadDir, displayName);

          await db
            .update(fileDownloads)
            .set({
              locationPath,
              fileName: displayName,
              fileType: ext,
              status: 'downloading',
              fileSize: totalBytes,
              updatedAt: new Date(),
            })
            .where(eq(fileDownloads.id, id));

          progressInterval = setInterval(() => {
            if (done) return;
            const downloaded = selectedFiles.reduce(
              (s: number, f: any) => s + f.downloaded,
              0,
            );
            const pct = totalBytes
              ? ((downloaded / totalBytes) * 100).toFixed(2)
              : null;
            progressMap.set(id, {
              downloadedBytes: downloaded,
              totalBytes,
              percentFixed2: pct,
              percent: pct ? Math.round(+pct) : null,
            });

            if (selectedFiles.every((f: any) => f.progress === 1)) {
              cleanup('completed').then(resolve).catch(reject);
            }
          }, 5000);

          torrent.on('error', async (err: Error) => {
            await cleanup('failed', err.message);
            reject(err);
          });
        },
      );

      client.on('error', (err: Error) => {
        cleanup('failed', err.message).then(() => reject(err));
      });
    });
  }

  // ── Stream torrent → MEGA (zero disk) ───────────────────────────────────────

  async streamToMega(
    id: string,
    magnetLink: string,
    options: {
      fileName?: string | null;
      fileIndices?: number[] | null;
      guestId?: string | null;
    } = {},
  ) {
    const mega = await this.megaService.getInstance();
    if ((mega as any).ready?.then) await (mega as any).ready;

    const uploadTarget = options.guestId
      ? await this.megaService.getOrCreateFolder(
          (mega as any).root,
          options.guestId,
        )
      : (mega as any).root;

    return new Promise<void>((resolve, reject) => {
      let progressInterval: NodeJS.Timeout | null = null;
      let torrentRef: any = null;
      let isFinalized = false;

      const cleanupAndFinish = async (
        status: 'completed' | 'failed',
        err?: Error,
      ) => {
        if (isFinalized) return;
        isFinalized = true;
        if (progressInterval) clearInterval(progressInterval);
        try { torrentRef?.destroy({ destroyStore: true }); } catch (_) {}

        await db
          .update(fileDownloads)
          .set({ status, errorMessage: err?.message ?? null, updatedAt: new Date() })
          .where(eq(fileDownloads.id, id));

        if (status === 'completed') {
          progressMap.set(id, {
            downloadedBytes: 0,
            totalBytes: 0,
            percent: 100,
            percentFixed2: '100.00',
            done: true,
          });
          resolve();
        } else {
          progressMap.set(id, {
            downloadedBytes: null,
            totalBytes: null,
            percentFixed2: null,
            percent: null,
            done: true,
          });
          reject(err);
        }
      };

      const client = makeTorrentClient({
        maxConns: 6,
        downloadLimit: 1.5 * 1024 * 1024,
        uploadLimit: 100 * 1024,
      });

      client.add(
        magnetLink,
        {
          // Pass MemoryChunkStore as a constructor — webtorrent calls `new store(...)`
          store: MemoryChunkStore,
          announce: PUBLIC_TRACKERS,
        } as any,
        async (torrent: any) => {
          torrentRef = torrent;

          if (!torrent.files?.length) {
            await new Promise((r) => torrent.once('ready', r));
          }

          const selectedFiles = this.selectFiles(torrent, options.fileIndices);
          const totalBytes = selectedFiles.reduce(
            (s: number, f: any) => s + f.length,
            0,
          );
          const baseFileName =
            options.fileName ??
            (selectedFiles.length === 1
              ? selectedFiles[0].name
              : torrent.name);
          const ext =
            selectedFiles.length === 1
              ? (selectedFiles[0].name.split('.').pop() ?? 'unknown')
              : 'mixed';

          await db
            .update(fileDownloads)
            .set({
              locationPath: baseFileName,
              fileName: baseFileName,
              fileType: ext,
              status: 'downloading',
              fileSize: totalBytes,
              updatedAt: new Date(),
            })
            .where(eq(fileDownloads.id, id));

          // Memory safety watchdog
          progressInterval = setInterval(() => {
            if (isFinalized) return;
            const memMB =
              process.memoryUsage().heapUsed / 1024 / 1024;
            if (memMB > 450) {
              this.logger.error(
                `Critical memory: ${memMB.toFixed(1)} MB — aborting`,
              );
              cleanupAndFinish(
                'failed',
                new Error(`Memory limit exceeded: ${memMB.toFixed(1)} MB`),
              );
            }
          }, 5000);

          let downloadedBytes = 0;

          for (const currentFile of selectedFiles) {
            if (isFinalized) break;

            const uploadName =
              selectedFiles.length === 1 && options.fileName
                ? options.fileName
                : currentFile.name;
            const pieceLength: number = torrent.pieceLength ?? 262144;

            // Get the store instance webtorrent created for this torrent
            const storeInstance = (torrent as any)._store as any ?? null;

            let lastEvicted = -1;
            let fileBytes = 0;

            await new Promise<void>((res, rej) => {
              const tracker = new Transform({
                highWaterMark: 16 * 1024,
                transform(chunk, _enc, cb) {
                  downloadedBytes += chunk.length;
                  fileBytes += chunk.length;

                  const pct = totalBytes
                    ? ((downloadedBytes / totalBytes) * 100).toFixed(2)
                    : null;
                  progressMap.set(id, {
                    downloadedBytes,
                    totalBytes,
                    percentFixed2: pct,
                    percent: pct ? Math.round(+pct) : null,
                  });

                  // Evict consumed pieces to free memory
                  if (storeInstance) {
                    const consumed = Math.floor(
                      (currentFile.offset + fileBytes) / pieceLength,
                    );
                    if (consumed > lastEvicted + 30) {
                      for (
                        let p = lastEvicted + 1;
                        p < consumed - 30;
                        p++
                      ) {
                        storeInstance.evict(p);
                      }
                      lastEvicted = consumed - 30;
                    }
                  }

                  this.push(chunk);
                  cb();
                },
              });

              const megaStream = uploadTarget.upload({
                name: uploadName,
                size: currentFile.length,
                allowUploadBuffering: true,
              });

              const torrentStream = currentFile.createReadStream({
                autoClose: false,
              });

              torrentStream.pipe(tracker).pipe(megaStream);

              megaStream.on('complete', () => {
                torrentStream.destroy();
                tracker.destroy();
                res();
              });

              const onErr = (e: Error) => rej(e);
              megaStream.on('error', onErr);
              torrentStream.on('error', onErr);
              tracker.on('error', onErr);
            }).catch((e) => cleanupAndFinish('failed', e as Error));
          }

          if (!isFinalized) {
            cleanupAndFinish('completed');
          }
        },
      );

      client.on('error', (err: Error) =>
        cleanupAndFinish('failed', err),
      );
    });
  }
}
