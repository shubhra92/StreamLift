import { Injectable, Logger } from '@nestjs/common';
import { createWriteStream, mkdirSync } from 'fs';
import { join } from 'path';
import { db, fileDownloads } from '../../db/index.js';
import { eq } from 'drizzle-orm';
import { progressMap } from '../../common/progress.store.js';
import { MegaService } from '../mega/mega.service.js';

@Injectable()
export class StreamDownloadService {
  private readonly logger = new Logger(StreamDownloadService.name);
  private readonly serverEnabled =
    process.env.SERVER_DOWNLOAD_ENABLED === 'true';

  constructor(private readonly megaService: MegaService) {}

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async fetchWithRetry(
    url: string,
    retries = 3,
    timeout = 30_000,
  ): Promise<Response> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), timeout);
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });
        clearTimeout(tid);
        return res;
      } catch (err: any) {
        this.logger.warn(`Fetch attempt ${attempt}/${retries} failed: ${err.message}`);
        if (attempt === retries) throw err;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    throw new Error('fetchWithRetry exhausted');
  }

  private parseFilename(
    response: Response,
    fallbackExt: string,
    override?: string,
  ): string {
    return (
      override ??
      response.headers
        .get('content-disposition')
        ?.match(/filename="([^"]+)"/)?.[1] ??
      `file.${fallbackExt}`
    );
  }

  private failProgress(id: string) {
    progressMap.set(id, {
      downloadedBytes: null,
      totalBytes: null,
      percentFixed2: null,
      percent: null,
      done: true,
    });
  }

  // ── Server local download ────────────────────────────────────────────────────

  async downloadToServer(
    id: string,
    url: string,
    options: { fileName?: string | null; guestId?: string | null } = {},
  ): Promise<void> {
    if (!this.serverEnabled) {
      await db
        .update(fileDownloads)
        .set({ status: 'failed', errorMessage: 'server download not available', updatedAt: new Date() })
        .where(eq(fileDownloads.id, id));
      this.failProgress(id);
      return;
    }

    const response = await fetch(url);
    if (!response.ok) {
      const msg = await response.text();
      await db
        .update(fileDownloads)
        .set({ status: 'failed', errorMessage: msg, updatedAt: new Date() })
        .where(eq(fileDownloads.id, id));
      this.failProgress(id);
      throw new Error(`Download failed: ${response.status}`);
    }

    const [fileType, ext] = (response.headers.get('content-type') ?? '/bin').split('/');
    const filename = this.parseFilename(response, ext, options.fileName ?? undefined);
    const dir = options.guestId
      ? join('downloads', options.guestId)
      : join('downloads');

    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, filename);
    const totalBytes = Number(response.headers.get('content-length')) || 0;
    let downloadedBytes = 0;
    const fileStream = createWriteStream(filePath);

    await db
      .update(fileDownloads)
      .set({
        locationPath: filePath,
        fileName: filename,
        fileType,
        status: 'downloading',
        fileSize: totalBytes,
        updatedAt: new Date(),
      })
      .where(eq(fileDownloads.id, id));

    await new Promise<void>((resolve, reject) => {
      response.body!.pipeTo(
        new WritableStream({
          write(chunk) {
            downloadedBytes += chunk.length;
            fileStream.write(chunk);
            progressMap.set(id, {
              downloadedBytes,
              totalBytes: totalBytes || null,
              percentFixed2: totalBytes
                ? ((downloadedBytes / totalBytes) * 100).toFixed(2)
                : null,
              percent: totalBytes
                ? Math.round((downloadedBytes / totalBytes) * 100)
                : null,
            });
          },
          close() {
            fileStream.end();
            db.update(fileDownloads)
              .set({ status: 'completed', updatedAt: new Date() })
              .where(eq(fileDownloads.id, id))
              .then(() => {
                progressMap.set(id, {
                  downloadedBytes,
                  totalBytes,
                  percent: 100,
                  percentFixed2: '100.00',
                  done: true,
                });
                resolve();
              })
              .catch(() => resolve());
          },
          abort(err) {
            db.update(fileDownloads)
              .set({
                status: 'failed',
                errorMessage: (err as any)?.message ?? 'stream aborted',
                updatedAt: new Date(),
              })
              .where(eq(fileDownloads.id, id))
              .finally(() => {
                progressMap.set(id, { downloadedBytes: null, totalBytes: null, percentFixed2: null, percent: null, done: true });
                reject(err);
              });
          },
        }),
      );
    });
  }

  // ── Stream URL → MEGA ───────────────────────────────────────────────────────

  async streamToMega(
    id: string,
    url: string,
    options: { fileName?: string | null; guestId?: string | null } = {},
  ): Promise<void> {
    const mega = await this.megaService.getInstance();
    if ((mega as any).ready?.then) await (mega as any).ready;

    const response = await this.fetchWithRetry(url);
    if (!response.ok) {
      const msg = await response.text();
      await db
        .update(fileDownloads)
        .set({ status: 'failed', errorMessage: msg, updatedAt: new Date() })
        .where(eq(fileDownloads.id, id));
      this.failProgress(id);
      throw new Error(`Download failed: ${response.status}`);
    }

    const [fileType, ext] = (response.headers.get('content-type') ?? '/bin').split('/');
    const filename = this.parseFilename(response, ext, options.fileName ?? undefined);
    const totalBytes = Number(response.headers.get('content-length')) || 0;
    let downloadedBytes = 0;

    const uploadTarget = options.guestId
      ? await this.megaService.getOrCreateFolder((mega as any).root, options.guestId)
      : (mega as any).root;

    const fileStream = uploadTarget.upload({ name: filename, size: totalBytes });

    await db
      .update(fileDownloads)
      .set({
        locationPath: filename,
        fileName: filename,
        fileType,
        status: 'downloading',
        fileSize: totalBytes,
        updatedAt: new Date(),
      })
      .where(eq(fileDownloads.id, id));

    await new Promise<void>((resolve, reject) => {
      fileStream.on('complete', () => {
        this.logger.log('MEGA upload completed ✅');
        db.update(fileDownloads)
          .set({ status: 'completed', updatedAt: new Date() })
          .where(eq(fileDownloads.id, id))
          .then(() => {
            progressMap.set(id, { downloadedBytes, totalBytes, percent: 100, percentFixed2: '100.00', done: true });
            resolve();
          })
          .catch(() => resolve());
      });

      fileStream.on('error', (err: Error) => {
        db.update(fileDownloads)
          .set({ status: 'failed', errorMessage: err.message, updatedAt: new Date() })
          .where(eq(fileDownloads.id, id))
          .finally(() => {
            progressMap.set(id, { downloadedBytes: null, totalBytes: null, percentFixed2: null, percent: null, done: true });
            reject(err);
          });
      });

      response.body!.pipeTo(
        new WritableStream({
          write(chunk) {
            downloadedBytes += chunk.length;
            progressMap.set(id, {
              downloadedBytes,
              totalBytes: totalBytes || null,
              percentFixed2: totalBytes
                ? ((downloadedBytes / totalBytes) * 100).toFixed(2)
                : null,
              percent: totalBytes
                ? Math.round((downloadedBytes / totalBytes) * 100)
                : null,
            });

            return new Promise<void>((res, rej) => {
              const ok = fileStream.write(chunk, (err: Error | null | undefined) => {
                if (err) rej(err);
                else res();
              });
              if (!ok) fileStream.once('drain', res);
            });
          },
          close() {
            fileStream.end();
          },
          abort(err) {
            fileStream.destroy?.();
            db.update(fileDownloads)
              .set({ status: 'failed', errorMessage: (err as any)?.message ?? 'stream aborted', updatedAt: new Date() })
              .where(eq(fileDownloads.id, id))
              .finally(() => {
                progressMap.set(id, { downloadedBytes: null, totalBytes: null, percentFixed2: null, percent: null, done: true });
                reject(err);
              });
          },
        }),
      );
    });
  }
}
