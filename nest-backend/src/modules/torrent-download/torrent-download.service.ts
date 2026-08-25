import { Injectable, Logger } from '@nestjs/common';
import WebTorrent from 'webtorrent';
import { join } from 'path';
import { Transform } from 'stream';
import { db, fileDownloads } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { progressMap } from '../../common/progress.store.js';
import { getCloudUploadFns } from '../../utils/cloud-provider.js';
import { MegaService } from '../mega/mega.service.js';

// ── Module-level singleton WebTorrent client ─────────────────────────────────

function makeTorrentClient(opts: Record<string, any> = {}) {
  return new WebTorrent({
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
    ...opts,
  } as any);
}

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
    torrent.deselect(0, torrent.pieces.length - 1, false);
    torrent.files.forEach((f: any) => f.deselect());

    if (fileIndices?.length) {
      const selected = fileIndices
        .map((i) => torrent.files[i])
        .filter(Boolean);
      selected.forEach((f: any) => f.select());
      this.logger.log(`📄 Selected ${selected.length} files by index`);
      return selected;
    }

    const largest = torrent.files.reduce((a: any, b: any) =>
      b.length > a.length ? b : a,
    );
    largest.select();
    this.logger.log(`📄 Auto-selected largest file: ${largest.name}`);
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

    this.logger.log(`🧲 Starting server torrent download for ID: ${id}`);
    this.logger.log(`🔍 Magnet link: ${magnetLink.substring(0, 100)}...`);

    const downloadDir = options.guestId
      ? join(process.cwd(), 'downloads', options.guestId)
      : join(process.cwd(), 'downloads');

    this.logger.log(`📂 Download directory: ${downloadDir}`);

    const client = makeTorrentClient();

    return new Promise<void>((resolve, reject) => {
      let progressInterval: NodeJS.Timeout | null = null;
      let torrentRef: any = null;
      let isFinalized = false;

      let metadataTimeout: NodeJS.Timeout | null = null;
      let progressTimeout30: NodeJS.Timeout | null = null;
      let progressTimeout60: NodeJS.Timeout | null = null;
      let progressTimeout90: NodeJS.Timeout | null = null;

      const cleanup = async (status: string, errMsg?: string) => {
        if (isFinalized) return;
        isFinalized = true;
        if (progressInterval) clearInterval(progressInterval);
        if (metadataTimeout) clearTimeout(metadataTimeout);
        if (progressTimeout30) clearTimeout(progressTimeout30);
        if (progressTimeout60) clearTimeout(progressTimeout60);
        if (progressTimeout90) clearTimeout(progressTimeout90);

        if (torrentRef) {
          try {
            torrentRef.destroy({ destroyStore: false });
            this.logger.log('🔌 WebTorrent instance closed down safely (files preserved).');
          } catch (_) {}
          torrentRef = null;
        }

        try { client.destroy(); } catch (_) {}

        await db
          .update(fileDownloads)
          .set({ status, errorMessage: errMsg ?? null, updatedAt: new Date() })
          .where(eq(fileDownloads.id, id))
          .catch((e) => this.logger.error('⚠️ DB update error (non-fatal): ' + e.message));

        progressMap.set(id, {
          downloadedBytes: null,
          totalBytes: null,
          percentFixed2: null,
          percent: null,
          done: true,
        });
      };

      // ── Metadata timeout (120s) ──────────────────────────────────────────
      metadataTimeout = setTimeout(() => {
        if (!torrentRef || !torrentRef.ready) {
          const err = new Error('Torrent metadata fetch timeout after 120 seconds.');
          this.logger.error('❌ ' + err.message);
          cleanup('failed', err.message).then(() => reject(err));
        }
      }, 120000);

      progressTimeout30 = setTimeout(() => {
        if (!torrentRef) this.logger.log('⏳ Still waiting for metadata... (30s)');
      }, 30000);
      progressTimeout60 = setTimeout(() => {
        if (!torrentRef) this.logger.log('⏳ Still waiting for metadata... (60s)');
      }, 60000);
      progressTimeout90 = setTimeout(() => {
        if (!torrentRef) this.logger.warn('⏳ Still waiting for metadata... (90s) — will timeout in 30s');
      }, 90000);

      // ── Add torrent to client ────────────────────────────────────────────
      this.logger.log('📡 Adding torrent to WebTorrent client...');

      client.add(
        magnetLink,
        {
          path: downloadDir,
          announce: PUBLIC_TRACKERS,
        } as any,
        async (torrent: any) => {
          try {
            torrentRef = torrent;
            this.logger.log('✅ Torrent added to client successfully');
            clearTimeout(metadataTimeout);
            clearTimeout(progressTimeout30);
            clearTimeout(progressTimeout60);
            clearTimeout(progressTimeout90);

            this.logger.log(`🔍 InfoHash: ${torrent.infoHash}`);
            this.logger.log(`📊 Initial state — Ready: ${torrent.ready}, Files: ${torrent.files?.length || 0}, Peers: ${torrent.numPeers}`);

            // Wait for metadata if not already ready
            if (!torrent.name || !torrent.files || torrent.files.length === 0) {
              this.logger.log('⏳ Waiting for torrent metadata...');
              const readyPromise = new Promise((r) => torrent.once('ready', r));
              const timeoutPromise = new Promise((_, rej) =>
                setTimeout(() => rej(new Error('Torrent ready timeout after 45 seconds')), 45000),
              );
              await Promise.race([readyPromise, timeoutPromise]);
            }

            this.logger.log(`✅ Torrent metadata received: ${torrent.name}`);
            this.logger.log(`📊 Torrent stats — Files: ${torrent.files.length}, Size: ${(torrent.length / 1024 / 1024).toFixed(2)} MB, Peers: ${torrent.numPeers}`);

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

            this.logger.log(`📄 Selected ${selectedFiles.length} files, total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
            this.logger.log(`📂 Location path: ${locationPath}`);

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
              .where(eq(fileDownloads.id, id))
              .catch((e) => this.logger.error('⚠️ DB update error (non-fatal): ' + e.message));

            // ── Periodic progress logger ─────────────────────────────────
            progressInterval = setInterval(() => {
              if (isFinalized) return;
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

              const memUsage = process.memoryUsage();
              const memUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);

              this.logger.log(
                `📊 Progress: ${pct ?? '0.00'}% | ` +
                `Speed: ${(torrent.downloadSpeed / 1024 / 1024).toFixed(2)} MB/s | ` +
                `Peers: ${torrent.numPeers} | ` +
                `Downloaded: ${(downloaded / 1024 / 1024).toFixed(2)} MB / ${(totalBytes / 1024 / 1024).toFixed(2)} MB | ` +
                `Memory: ${memUsedMB} MB`,
              );

              if (torrent.numPeers === 0 && downloaded === 0) {
                this.logger.warn('⚠️ No peers connected yet.');
              }

              if (parseFloat(memUsedMB) > 400) {
                this.logger.warn(`⚠️ HIGH MEMORY: ${memUsedMB} MB — forcing GC`);
                if (global.gc) global.gc();
              }
              if (parseFloat(memUsedMB) > 450) {
                this.logger.error(`❌ CRITICAL MEMORY: ${memUsedMB} MB — aborting`);
                cleanup('failed', `Memory limit exceeded: ${memUsedMB} MB`).then(() => reject(new Error(`Memory limit: ${memUsedMB} MB`)));
              }

              if (selectedFiles.every((f: any) => f.progress === 1)) {
                this.logger.log('🎉 All files downloaded to disk.');
                cleanup('completed').then(resolve).catch(reject);
              }
            }, 5000);

            // ── Peer monitoring ────────────────────────────────────────────
            torrent.on('wire', (wire: any) => {
              this.logger.log(`🔗 Connected to peer: ${wire.remoteAddress ?? 'unknown'}`);
            });
            torrent.on('noPeers', (type: string) => {
              this.logger.warn(`⚠️ No peers found via ${type}.`);
            });
            torrent.on('error', async (err: Error) => {
              this.logger.error(`❌ Torrent error: ${err.message}`);
              await cleanup('failed', err.message);
              reject(err);
            });
          } catch (error) {
            this.logger.error('❌ Error in torrent handler: ' + (error as Error).message);
            await cleanup('failed', (error as Error).message);
            reject(error);
          }
        },
      );

      client.on('error', (err: Error) => {
        this.logger.error('❌ WebTorrent client error: ' + err.message);
        clearTimeout(metadataTimeout);
        clearTimeout(progressTimeout30);
        clearTimeout(progressTimeout60);
        clearTimeout(progressTimeout90);
        cleanup('failed', err.message).then(() => reject(err));
      });
    });
  }

  // ── Stream torrent → Cloud (via provider abstraction) ──────────────────────────

  async streamToCloud(
    id: string,
    magnetLink: string,
    options: {
      fileName?: string | null;
      fileIndices?: number[] | null;
      guestId?: string | null;
    } = {},
  ): Promise<void> {
    this.logger.log(`Starting torrent download to cloud: ${id}`);
    this.logger.log(`Magnet link: ${magnetLink.substring(0, 80)}...`);
    const { streamTorrentToCloud } = await getCloudUploadFns();
    const mega = await this.megaService.getInstance();
    await streamTorrentToCloud(id, magnetLink, options, mega);
  }
}
