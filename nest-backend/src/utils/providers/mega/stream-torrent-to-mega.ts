import { Logger } from '@nestjs/common';
import { Transform } from 'stream';
import WebTorrent from 'webtorrent';
import { db, fileDownloads } from '../../../db/index.js';
import { eq } from 'drizzle-orm';
import { progressMap } from '../../../common/progress.store.js';

const logger = new Logger('StreamTorrentToMega');

// ── In-memory chunk store ────────────────────────────────────────────────────
// Matches express-backend FreeTierChunkStore — tracks eviction frontier.

function MemoryChunkStore(this: any, chunkLength: number, _opts: any) {
  this.chunkLength = chunkLength;
  this.chunks = new Map<number, Buffer>();
}

MemoryChunkStore.prototype.put = function (
  index: number,
  buf: Buffer,
  cb: (err?: Error | null) => void,
) {
  this.chunks.set(index, buf);
  if (cb) cb(null);
};

MemoryChunkStore.prototype.get = function (
  index: number,
  opts: any,
  cb: (err: Error | null, buf?: Buffer) => void,
) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const buf = this.chunks.get(index) as Buffer | undefined;
  if (!buf) return cb(new Error('Chunk not found'));
  const start = opts?.offset ?? 0;
  const end = opts?.length != null ? start + opts.length : buf.length;
  cb(null, buf.slice(start, end));
};

MemoryChunkStore.prototype.close = function (cb?: () => void) {
  this.chunks.clear();
  cb?.();
};

MemoryChunkStore.prototype.destroy = function (cb?: () => void) {
  this.chunks.clear();
  cb?.();
};

MemoryChunkStore.prototype.evict = function (index: number) {
  this.chunks.delete(index);
};

// ── Module-level singleton WebTorrent client ─────────────────────────────────

const client = new WebTorrent({
  dht: false,
  utp: false,
  natUpnp: false,
  natPmp: false,
  lsd: false,
  tracker: {
    getAnnounceOpts: () => ({ numwant: 20, compact: 1 }),
    rtcConfig: false,
    wrtc: false,
  },
  maxConns: 6,
  downloadLimit: 1.5 * 1024 * 1024,
  uploadLimit: 100 * 1024,
} as any);

const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.moeking.me:6969/announce',
  'https://tracker.nanoha.org:443/announce',
  'https://tracker.lilithraws.org:443/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://explodie.org:6969/announce',
];

// ── Main Export ─────────────────────────────────────────────────────────────

export async function streamTorrentToMega(
  id: string,
  magnetLink: string,
  options: {
    fileName?: string | null;
    fileIndices?: number[] | null;
    guestId?: string | null;
  } = {},
  megaInstance: any,
): Promise<void> {
  const mega = megaInstance;
  if ((mega as any).ready?.then) await (mega as any).ready;

  const uploadTarget = options.guestId
    ? await getOrCreateFolder(mega.root, options.guestId)
    : mega.root;

  return new Promise<void>((resolve, reject) => {
    logger.log(`🧲 Starting cloud-stream torrent download for ID: ${id}`);
    logger.log(`🔍 Magnet link: ${magnetLink.substring(0, 100)}...`);

    let progressInterval: NodeJS.Timeout | null = null;
    let torrentInstance: any = null;
    let isFinalized = false;
    let customStoreInstance: any = null;

    let metadataTimeout: NodeJS.Timeout | null = null;
    let progressTimeout30: NodeJS.Timeout | null = null;
    let progressTimeout60: NodeJS.Timeout | null = null;
    let progressTimeout90: NodeJS.Timeout | null = null;

    let currentTorrentStream: any = null;
    let currentTrackingStream: any = null;
    let currentFileStream: any = null;

    let downloadedBytes = 0;
    let totalBytes = 0;

    // ── Centralized cleanup ────────────────────────────────────────────────
    const cleanupAndFinish = async (
      status: 'completed' | 'failed',
      err?: Error | null,
      uploadedFiles?: any,
    ) => {
      if (isFinalized) return;
      isFinalized = true;

      if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
      if (metadataTimeout) clearTimeout(metadataTimeout);
      if (progressTimeout30) clearTimeout(progressTimeout30);
      if (progressTimeout60) clearTimeout(progressTimeout60);
      if (progressTimeout90) clearTimeout(progressTimeout90);

      if (currentTorrentStream) { try { currentTorrentStream.destroy(); } catch (_) {} }
      if (currentTrackingStream) { try { currentTrackingStream.destroy(); } catch (_) {} }
      if (currentFileStream) { try { currentFileStream.destroy(); } catch (_) {} }

      if (torrentInstance) {
        try {
          torrentInstance.destroy({ destroyStore: true });
          logger.log('🔌 WebTorrent instance closed down safely (files preserved).');
        } catch (e) {
          logger.error('Error destroying torrent: ' + (e as Error).message);
        }
        torrentInstance = null;
      }

      if (customStoreInstance) {
        try { customStoreInstance.destroy(); } catch (_) {}
        customStoreInstance = null;
      }

      if (status === 'completed') {
        await db
          .update(fileDownloads)
          .set({ status: 'completed', updatedAt: new Date() })
          .where(eq(fileDownloads.id, id))
          .catch((e) => logger.error('⚠️ DB update error (non-fatal): ' + e.message));

        progressMap.set(id, {
          downloadedBytes: totalBytes,
          totalBytes,
          percent: 100,
          percentFixed2: '100.00',
          done: true,
        });
        logger.log(`💾 Database synced state status: = ${status}`);
        resolve();
      } else {
        await db
          .update(fileDownloads)
          .set({ status: 'failed', errorMessage: err?.message ?? 'Stream upload failed', updatedAt: new Date() })
          .where(eq(fileDownloads.id, id))
          .catch((e) => logger.error('⚠️ DB update error (non-fatal): ' + e.message));

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

    // ── Metadata timeout (120s) ────────────────────────────────────────────
    metadataTimeout = setTimeout(() => {
      if (!torrentInstance || !torrentInstance.ready) {
        const timeoutError = new Error('Torrent metadata fetch timeout after 120 seconds. Torrent may be dead or have no seeders.');
        logger.error('❌ Metadata timeout: ' + timeoutError.message);
        cleanupAndFinish('failed', timeoutError);
      }
    }, 120000);

    progressTimeout30 = setTimeout(() => {
      if (!torrentInstance) logger.log('⏳ Still waiting for metadata... (30s elapsed)');
    }, 30000);

    progressTimeout60 = setTimeout(() => {
      if (!torrentInstance) logger.log('⏳ Still waiting for metadata... (60s elapsed)');
    }, 60000);

    progressTimeout90 = setTimeout(() => {
      if (!torrentInstance) logger.warn('⏳ Still waiting for metadata... (90s) — will timeout in 30s');
    }, 90000);

    // ── Add torrent ────────────────────────────────────────────────────────
    logger.log('📡 Adding torrent to WebTorrent client...');

    client.add(
      magnetLink,
      {
        store: function (chunkLength: number, storeOpts: any) {
          customStoreInstance = new (MemoryChunkStore as any)(chunkLength, storeOpts);
          return customStoreInstance;
        },
        announce: PUBLIC_TRACKERS,
      } as any,
      (torrent: any) => {
        logger.log('✅ Torrent added to client successfully');
        clearTimeout(metadataTimeout);
        clearTimeout(progressTimeout30);
        clearTimeout(progressTimeout60);
        clearTimeout(progressTimeout90);
        handleTorrent(torrent);
      },
    );

    client.on('error', (err: Error) => {
      logger.error('❌ WebTorrent client error: ' + err.message);
      clearTimeout(metadataTimeout);
      clearTimeout(progressTimeout30);
      clearTimeout(progressTimeout60);
      clearTimeout(progressTimeout90);
      if (!isFinalized) cleanupAndFinish('failed', err);
    });

    // ── Main handler (wrapped in try/catch) ────────────────────────────────
    async function handleTorrent(torrent: any) {
      try {
        torrentInstance = torrent;

        logger.log(`🔍 InfoHash: ${torrent.infoHash}`);
        logger.log(`📊 Initial state — Ready: ${torrent.ready}, Files: ${torrent.files?.length || 0}, Peers: ${torrent.numPeers}`);

        // Wait for metadata if not already ready
        if (!torrent.name || !torrent.files || torrent.files.length === 0) {
          logger.log('⏳ Waiting for torrent metadata...');
          const readyPromise = new Promise((r) => torrent.once('ready', r));
          const timeoutPromise = new Promise((_, rej) =>
            setTimeout(() => rej(new Error('Torrent ready timeout after 45 seconds')), 45000),
          );
          await Promise.race([readyPromise, timeoutPromise]);
        }

        logger.log(`✅ Torrent metadata received: ${torrent.name}`);
        logger.log(`📊 Torrent stats — Files: ${torrent.files.length}, Size: ${(torrent.length / 1024 / 1024).toFixed(2)} MB, Peers: ${torrent.numPeers}`);

        // Select files
        const selectedFiles = selectFiles(torrent, options.fileIndices);
        totalBytes = selectedFiles.reduce((s: number, f: any) => s + f.length, 0);
        downloadedBytes = 0;

        const baseFileName =
          options.fileName ??
          (selectedFiles.length === 1 ? selectedFiles[0].name : torrent.name);
        const ext =
          selectedFiles.length === 1
            ? (selectedFiles[0].name.split('.').pop() ?? 'unknown')
            : 'mixed';

        logger.log(`📄 Selected ${selectedFiles.length} files via explicit indices.`);

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
          .where(eq(fileDownloads.id, id))
          .catch((e) => logger.error('⚠️ DB update error (non-fatal): ' + e.message));

        // ── Periodic progress logger ───────────────────────────────────────
        progressInterval = setInterval(() => {
          if (isFinalized) return;

          const displayPercent = totalBytes
            ? ((downloadedBytes / totalBytes) * 100).toFixed(2)
            : '0.00';
          const memUsage = process.memoryUsage();
          const memUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
          const downloadedMB = (downloadedBytes / 1024 / 1024).toFixed(2);
          const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
          const speedMBps = torrentInstance?.downloadSpeed
            ? (torrentInstance.downloadSpeed / 1024 / 1024).toFixed(2)
            : '0.00';

          logger.log(
            `📊 Progress: ${displayPercent}% | ` +
            `Speed: ${speedMBps} MB/s | ` +
            `Peers: ${torrentInstance?.numPeers ?? 0} | ` +
            `Downloaded: ${downloadedMB} MB / ${totalMB} MB | ` +
            `Memory: ${memUsedMB} MB`,
          );

          if (torrentInstance?.numPeers === 0 && downloadedBytes === 0) {
            logger.warn('⚠️ No peers connected yet. This may indicate network restrictions or unavailable torrent.');
          }

          const memUsedMBNum = parseFloat(memUsedMB);
          if (memUsedMBNum > 400) {
            logger.warn(`⚠️ HIGH MEMORY USAGE: ${memUsedMB} MB — Forcing garbage collection`);
            if (global.gc) global.gc();
          }
          if (memUsedMBNum > 450) {
            logger.error(`❌ CRITICAL MEMORY: ${memUsedMB} MB — Aborting to prevent crash`);
            cleanupAndFinish('failed', new Error(`Memory limit exceeded: ${memUsedMB} MB`));
          }
        }, 5000);

        // ── Peer monitoring (single attachment) ────────────────────────────
        torrent.on('wire', (wire: any) => {
          logger.log(`🔗 Connected to peer: ${wire.remoteAddress ?? 'unknown'}`);
        });

        torrent.on('noPeers', (announceType: string) => {
          logger.warn(`⚠️ No peers found via ${announceType}. Trying other trackers...`);
        });

        torrent.on('error', (err: Error) => {
          logger.error(`❌ Torrent error: ${err.message}`);
          cleanupAndFinish('failed', err);
        });

        // ── Sequential file upload loop ────────────────────────────────────
        const uploadedResults: any[] = [];

        for (let i = 0; i < selectedFiles.length; i++) {
          if (isFinalized) break;

          const currentFile = selectedFiles[i];
          const targetUploadName =
            selectedFiles.length === 1 && options.fileName
              ? options.fileName
              : currentFile.name;

          logger.log(`🚀 [File ${i + 1}/${selectedFiles.length}] Streaming "${currentFile.name}" directly to MEGA...`);
          logger.log(`📦 File size: ${(currentFile.length / 1024 / 1024).toFixed(2)} MB`);

          await new Promise<void>((resolveFile, rejectFile) => {
            let fileDownloadedBytes = 0;
            let lastConsumedPiece = -1;
            const pieceLength = torrent.pieceLength || 262144;

            currentTrackingStream = new Transform({
              highWaterMark: 16 * 1024,
              transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
                downloadedBytes += chunk.length;
                fileDownloadedBytes += chunk.length;

                const pct = totalBytes
                  ? ((downloadedBytes / totalBytes) * 100).toFixed(2)
                  : null;
                progressMap.set(id, {
                  downloadedBytes,
                  totalBytes,
                  percentFixed2: pct,
                  percent: pct ? Math.round(+pct) : null,
                });

                // Evict consumed pieces from memory store
                const consumedPiece = Math.floor(
                  (currentFile.offset + fileDownloadedBytes) / pieceLength,
                );
                if (customStoreInstance && consumedPiece > lastConsumedPiece + 30) {
                  for (let p = lastConsumedPiece + 1; p < consumedPiece - 30; p++) {
                    customStoreInstance.evict(p);
                  }
                  lastConsumedPiece = consumedPiece - 30;
                }

                this.push(chunk);
                cb();
              },
              flush(cb) {
                if (fileDownloadedBytes < currentFile.length) {
                  logger.error(`⚠️ Stream ended early: got ${fileDownloadedBytes} / ${currentFile.length} bytes`);
                  cb(new Error(`Incomplete download: ${fileDownloadedBytes} / ${currentFile.length} bytes`));
                } else {
                  logger.log(`✅ Stream complete: ${fileDownloadedBytes} bytes`);
                  cb();
                }
              },
            });

            currentFileStream = uploadTarget.upload({
              name: targetUploadName,
              size: currentFile.length,
              allowUploadBuffering: true,
            });

            currentTorrentStream = currentFile.createReadStream({ autoClose: false });

            currentTorrentStream.pipe(currentTrackingStream).pipe(currentFileStream);

            currentFileStream.on('complete', (uploadedFile: any) => {
              logger.log(`✅ Finished uploading target file: ${currentFile.name}`);
              uploadedResults.push(uploadedFile);
              currentTorrentStream.destroy();
              currentTrackingStream.destroy();
              resolveFile();
            });

            const handleStreamError = (err: Error) => {
              logger.error(`❌ Pipeline crash on "${currentFile.name}": ${err.message}`);
              rejectFile(err);
            };

            currentFileStream.on('error', handleStreamError);
            currentTorrentStream.on('error', handleStreamError);
            currentTrackingStream.on('error', handleStreamError);
          }).catch((e) => cleanupAndFinish('failed', e as Error));
        }

        if (!isFinalized) {
          logger.log('🎉 All selected batch items safely pushed into cloud environments!');
          logger.log('✅ Selected torrent contents finished downloading.');
          cleanupAndFinish('completed', null, uploadedResults.length === 1 ? uploadedResults[0] : uploadedResults);
        }
      } catch (error) {
        logger.error('❌ Error setting up torrent processing stream pipeline: ' + (error as Error).message);
        cleanupAndFinish('failed', error as Error);
      }
    }
  });
}

// ── Helper: select files ────────────────────────────────────────────────────

function selectFiles(torrent: any, fileIndices?: number[] | null): any[] {
  torrent.deselect(0, torrent.pieces.length - 1, false);
  torrent.files.forEach((f: any) => f.deselect());

  if (fileIndices?.length) {
    const selected = fileIndices.map((i) => torrent.files[i]).filter(Boolean);
    selected.forEach((f: any) => f.select());
    logger.log(`📄 Selected ${selected.length} files by index`);
    return selected;
  }

  const largest = torrent.files.reduce((a: any, b: any) => (b.length > a.length ? b : a));
  largest.select();
  logger.log(`📄 Auto-selected largest file: ${largest.name}`);
  return [largest];
}

// ── Helper: MEGA folder ─────────────────────────────────────────────────────

async function getOrCreateFolder(parentNode: any, guestId: string): Promise<any> {
  const folderName = guestId;
  const children = Object.values(parentNode.children ?? {}) as any[];
  const existing = children.find((n: any) => n.directory && n.name === folderName);
  if (existing) return existing;
  return parentNode.mkdir(folderName);
}
