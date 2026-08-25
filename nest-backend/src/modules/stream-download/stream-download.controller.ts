import { Body, Controller, HttpCode, Post, BadRequestException } from '@nestjs/common';
import { StreamDownloadService } from './stream-download.service.js';
import { StreamDownloadDto } from './stream-download.dto.js';
import { progressMap } from '../../common/progress.store.js';
import { db, fileDownloads } from '../../db/index.js';
import { eq } from 'drizzle-orm';

@Controller('stream-download')
export class StreamDownloadController {
  constructor(private readonly svc: StreamDownloadService) {}

  /** POST /api/stream-download/server */
  @Post('server')
  @HttpCode(200)
  async downloadServer(@Body() body: StreamDownloadDto) {
    const { source_url, file_name, file_id } = body;

    if (!source_url) throw new BadRequestException('source_url is required');

    if (file_id && progressMap.get(file_id)) {
      return { status: true, message: 'file download already started', data: { fileStatusId: file_id } };
    }

    let record = file_id
      ? (await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id)).limit(1))[0]
      : null;

    if (!record) {
      [record] = await db
        .insert(fileDownloads)
        .values({ location: 'server', sourceUrl: source_url, ...(file_name ? { fileName: file_name } : {}) })
        .returning();
    }

    const id = record.id;
    const guestId = record.guestId ?? null;
    progressMap.set(id, { downloadedBytes: 0, totalBytes: null, percentFixed2: null, percent: null });

    this.svc.downloadToServer(id, source_url, { fileName: file_name, guestId }).catch(console.error);

    return { status: true, message: 'download started', data: { fileStatusId: id } };
  }

  /** POST /api/stream-download/cloud */
  @Post('cloud')
  @HttpCode(200)
  async uploadMega(@Body() body: StreamDownloadDto) {
    const { source_url, file_name, file_id } = body;

    if (!source_url) throw new BadRequestException('source_url is required');

    const existing = file_id ? progressMap.get(file_id) : undefined;
    if (existing && !existing.done) {
      return { status: true, message: 'file download already started', data: { fileStatusId: file_id } };
    }

    let record = file_id
      ? (await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id)).limit(1))[0]
      : null;

    if (!record) {
      [record] = await db
        .insert(fileDownloads)
        .values({ location: 'cloud', sourceUrl: source_url, ...(file_name ? { fileName: file_name } : {}) })
        .returning();
    }

    const id = record.id;
    const guestId = record.guestId ?? null;
    progressMap.set(id, { downloadedBytes: 0, totalBytes: null, percentFixed2: null, percent: null });

    this.svc.streamToCloud(id, source_url, { fileName: file_name, guestId }).catch(console.error);

    return { status: true, message: 'upload to MEGA started', data: { fileStatusId: id } };
  }
}
