import { Logger } from '@nestjs/common';
import { db, fileDownloads } from '../../../db/index.js';
import { eq } from 'drizzle-orm';
import { progressMap } from '../../../common/progress.store.js';

const logger = new Logger('StreamUrlToMega');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; StreamLift/1.0)',
  'Accept': '*/*',
};

function parseContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) return decodeURIComponent(utf8Match[1].trim());
  const quotedMatch = header.match(/filename="([^"]+)"/i);
  if (quotedMatch) return quotedMatch[1].trim();
  const bareMatch = header.match(/filename=([^;]+)/i);
  if (bareMatch) return bareMatch[1].trim();
  return null;
}

function filenameFromUrl(rawUrl: string): string | null {
  try {
    const pathname = new URL(rawUrl).pathname;
    const last = pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

function extFromMime(mime: string | null): string | null {
  if (!mime) return null;
  const map: Record<string, string> = {
    'video/mp4': 'mp4', 'video/x-matroska': 'mkv', 'video/webm': 'webm',
    'video/avi': 'avi', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg',
    'audio/flac': 'flac', 'audio/wav': 'wav',
    'application/zip': 'zip', 'application/x-rar-compressed': 'rar',
    'application/x-7z-compressed': '7z', 'application/pdf': 'pdf',
    'application/octet-stream': 'bin',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp',
  };
  const base = (mime ?? '').split(';')[0].trim().toLowerCase();
  return map[base] ?? base.split('/')[1] ?? null;
}


async function fetchWithRetry(url: string, retries = 3, timeout = 30000): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(url, {
          method: 'HEAD',
          headers: HEADERS,
          signal: ctrl.signal,
          redirect: 'follow',
        });
        clearTimeout(tid);
        if (res.ok) return res;
      } finally {
        clearTimeout(tid);
      }

      const ctrl2 = new AbortController();
      const tid2 = setTimeout(() => ctrl2.abort(), timeout);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { ...HEADERS, 'Range': 'bytes=0-0' },
          signal: ctrl2.signal,
          redirect: 'follow',
        });
        clearTimeout(tid2);
        if (res.ok) return res;
      } finally {
        clearTimeout(tid2);
      }
    } catch (err: any) {
      logger.warn(`Fetch attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error('fetchWithRetry exhausted');
}

async function getOrCreateFolder(parentNode: any, guestId: string): Promise<any> {
  const folderName = guestId;
  const children = Object.values(parentNode.children ?? {}) as any[];
  const existing = children.find((n: any) => n.directory && n.name === folderName);
  if (existing) return existing;
  return parentNode.mkdir(folderName);
}

export async function streamUrlToMega(
  id: string,
  url: string,
  options: { fileName?: string | null; guestId?: string | null } = {},
  megaInstance: any
): Promise<void> {
  // fetchWithRetry does HEAD + Range probe to validate the URL.
  const probeResponse = await fetchWithRetry(url);
  if (!probeResponse.ok && probeResponse.status !== 206) {
    const msg = await probeResponse.text();
    await db
      .update(fileDownloads)
      .set({ status: 'failed', errorMessage: msg, updatedAt: new Date() })
      .where(eq(fileDownloads.id, id));
    progressMap.set(id, { downloadedBytes: null, totalBytes: null, percentFixed2: null, percent: null, done: true });
    throw new Error(`Download failed: ${probeResponse.status}`);
  }

  // Extract metadata from the probe response headers.
  const [fileType, ext] = (probeResponse.headers.get('content-type') ?? '/bin').split('/');
  const contentDisposition = probeResponse.headers.get('content-disposition');
  const rawName = parseContentDisposition(contentDisposition) ?? filenameFromUrl(url);
  const fileExtension = extFromMime(fileType);
  const fileName = options.fileName ?? rawName ?? (fileExtension ? `download.${fileExtension}` : 'download');
  const totalBytes = Number(probeResponse.headers.get('content-length')) ?? 0;

  // Now do a full GET for the actual body stream (the probe response body is consumed/unavailable).
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    redirect: 'follow',
  });
  if (!response.ok) {
    const msg = await response.text();
    await db
      .update(fileDownloads)
      .set({ status: 'failed', errorMessage: msg, updatedAt: new Date() })
      .where(eq(fileDownloads.id, id));
    progressMap.set(id, { downloadedBytes: null, totalBytes: null, percentFixed2: null, percent: null, done: true });
    throw new Error(`Download failed: ${response.status}`);
  }

  if (!response.body) {
    const err = new Error('Response body is null — server may not support streaming');
    await db
      .update(fileDownloads)
      .set({ status: 'failed', errorMessage: err.message, updatedAt: new Date() })
      .where(eq(fileDownloads.id, id));
    progressMap.set(id, { downloadedBytes: null, totalBytes: null, percentFixed2: null, percent: null, done: true });
    throw err;
  }

  let downloadedBytes = 0;

  const uploadTarget = options.guestId
    ? await getOrCreateFolder(megaInstance.root, options.guestId)
    : megaInstance.root;

  const fileStream = uploadTarget.upload({ name: fileName, size: totalBytes });

  await db
    .update(fileDownloads)
    .set({
      locationPath: fileName,
      fileName: fileName,
      fileType,
      status: 'downloading',
      fileSize: totalBytes,
      updatedAt: new Date(),
    })
    .where(eq(fileDownloads.id, id));

  await new Promise<void>((resolve, reject) => {
    fileStream.on('complete', () => {
      logger.log('MEGA upload completed ✅');
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
            percentFixed2: totalBytes ? ((downloadedBytes / totalBytes) * 100).toFixed(2) : null,
            percent: totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : null,
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



