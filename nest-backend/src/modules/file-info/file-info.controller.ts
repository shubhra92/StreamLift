import { Controller, Get, Query, Res, HttpException, HttpStatus } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';

// Use native fetch Response type
type FetchResponse = globalThis.Response;

@Controller('file-info')
export class FileInfoController {
  private readonly HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; StreamLift/1.0)',
    'Accept': '*/*',
  };

  @Get()
  async getFileInfo(
    @Query('url') url: string,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    if (!url) {
      throw new HttpException('url query param is required', HttpStatus.BAD_REQUEST);
    }

    // Basic URL validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new HttpException('Only http/https URLs are supported', HttpStatus.BAD_REQUEST);
      }
    } catch {
      throw new HttpException('Invalid URL', HttpStatus.BAD_REQUEST);
    }

    let response: FetchResponse;
    try {
      // Try HEAD first (no body, fast)
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10000);
      try {
        response = await fetch(url, {
          method: 'HEAD',
          headers: this.HEADERS,
          signal: ctrl.signal,
          redirect: 'follow',
        });
      } finally {
        clearTimeout(timeout);
      }

      // Some servers reject HEAD — fall back to GET with Range: bytes=0-0
      if (!response.ok) {
        const ctrl2 = new AbortController();
        const timeout2 = setTimeout(() => ctrl2.abort(), 10000);
        try {
          response = await fetch(url, {
            method: 'GET',
            headers: { ...this.HEADERS, 'Range': 'bytes=0-0' },
            signal: ctrl2.signal,
            redirect: 'follow',
          });
        } finally {
          clearTimeout(timeout2);
        }
        // Consume and discard the tiny body so the connection is released
        await response.body?.cancel?.();
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        throw new HttpException('Request timed out fetching file info', HttpStatus.GATEWAY_TIMEOUT);
      }
      throw new HttpException(
        { error: 'Could not reach the URL', details: err.message },
        HttpStatus.BAD_GATEWAY,
      );
    }

    if (!response.ok && response.status !== 206) {
      throw new HttpException(
        { error: `Remote server returned ${response.status}` },
        response.status,
      );
    }

    const contentType = response.headers.get('content-type') ?? null;
    const contentLength = response.headers.get('content-length') ??
      response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] ?? null;
    const contentDisposition = response.headers.get('content-disposition');

    const fileType = contentType ? contentType.split(';')[0].trim() : null;
    const fileExtension = this.extFromMime(fileType);
    const fileSize = contentLength ? Number(contentLength) : null;

    // Determine filename: content-disposition > URL path > fallback with ext
    const rawName = this.parseContentDisposition(contentDisposition) ?? this.filenameFromUrl(url);
    const fileName = rawName ?? (fileExtension ? `download.${fileExtension}` : 'download');

    res.json({ fileName, fileSize, fileType, fileExtension });
  }

  private parseContentDisposition(header: string | null): string | null {
    if (!header) return null;
    const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) return decodeURIComponent(utf8Match[1].trim());
    const quotedMatch = header.match(/filename="([^"]+)"/i);
    if (quotedMatch) return quotedMatch[1].trim();
    const bareMatch = header.match(/filename=([^;]+)/i);
    if (bareMatch) return bareMatch[1].trim();
    return null;
  }

  private filenameFromUrl(rawUrl: string): string | null {
    try {
      const pathname = new URL(rawUrl).pathname;
      const last = pathname.split('/').filter(Boolean).pop();
      return last ? decodeURIComponent(last) : null;
    } catch {
      return null;
    }
  }

  private extFromMime(mime: string | null): string | null {
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
}