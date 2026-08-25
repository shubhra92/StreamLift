import {
  Body, Controller, HttpCode, Post, BadRequestException,
} from '@nestjs/common';
import { TorrentDownloadService } from './torrent-download.service.js';
import { TorrentMetadataService } from './torrent-metadata.service.js';
import { TorrentDownloadDto } from './torrent-download.dto.js';
import { progressMap } from '../../common/progress.store.js';
import { db, fileDownloads } from '../../db/index.js';
import { eq } from 'drizzle-orm';

@Controller('torrent-download')
export class TorrentDownloadController {
  constructor(
    private readonly svc: TorrentDownloadService,
    private readonly metaSvc: TorrentMetadataService,
  ) {}

  /** POST /api/torrent-download/metadata */
  @Post('metadata')
  @HttpCode(200)
  async getMetadata(@Body() body: { magnet_link: string }) {
    const { magnet_link } = body;
    if (!magnet_link) throw new BadRequestException('magnet_link is required');
    if (!magnet_link.startsWith('magnet:?')) throw new BadRequestException('Invalid magnet link format');

    try {
      const data = await this.metaSvc.getMetadata(magnet_link);
      return { status: true, message: 'Metadata fetched successfully', data };
    } catch (err: any) {
      if (err.message === 'TIMEOUT') {
        return { status: false, message: 'Timeout: Could not fetch metadata. Torrent might be dead or have no seeders.' };
      }
      throw err;
    }
  }

  /** POST /api/torrent-download/server */
  @Post('server')
  @HttpCode(200)
  async downloadServer(@Body() body: TorrentDownloadDto) {
    const { magnet_link, file_name, file_id } = body;
    let { file_indices } = body;

    if (!magnet_link) throw new BadRequestException('magnet_link is required');
    if (!magnet_link.startsWith('magnet:?')) throw new BadRequestException('Invalid magnet link format');

    const existing = file_id ? progressMap.get(file_id) : undefined;
    if (existing && !existing.done) {
      return { status: true, message: 'torrent download already started', data: { fileStatusId: file_id } };
    }

    let record = file_id
      ? (await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id)).limit(1))[0]
      : null;

    if (record && !file_indices && record.selectedFileIndices) {
      try { file_indices = JSON.parse(record.selectedFileIndices); } catch (_) {}
    }

    if (!record) {
      [record] = await db.insert(fileDownloads).values({
        location: 'server',
        sourceUrl: magnet_link,
        downloadType: 'torrent',
        selectedFileIndices: file_indices ? JSON.stringify(file_indices) : null,
        ...(file_name ? { fileName: file_name } : {}),
      }).returning();
    }

    const id = record.id;
    const guestId = record.guestId ?? null;
    progressMap.set(id, { downloadedBytes: 0, totalBytes: record.fileSize ?? null, percentFixed2: null, percent: null });

    this.svc.downloadToServer(id, magnet_link, { fileName: record.fileName ?? file_name, fileIndices: file_indices, guestId }).catch(console.error);

    return { status: true, message: 'torrent download started', data: { fileStatusId: id } };
  }

  /** POST /api/torrent-download/cloud */
  @Post('cloud')
  @HttpCode(200)
  async uploadMega(@Body() body: TorrentDownloadDto) {
    const { magnet_link, file_name, file_id } = body;
    let { file_indices } = body;

    if (!magnet_link) throw new BadRequestException('magnet_link is required');
    if (!magnet_link.startsWith('magnet:?')) throw new BadRequestException('Invalid magnet link format');

    const existingMega = file_id ? progressMap.get(file_id) : undefined;
    if (existingMega && !existingMega.done) {
      return { status: true, message: 'torrent download already started', data: { fileStatusId: file_id } };
    }

    let record = file_id
      ? (await db.select().from(fileDownloads).where(eq(fileDownloads.id, file_id)).limit(1))[0]
      : null;

    if (record && !file_indices && record.selectedFileIndices) {
      try { file_indices = JSON.parse(record.selectedFileIndices); } catch (_) {}
    }

    if (!record) {
      [record] = await db.insert(fileDownloads).values({
        location: 'cloud',
        sourceUrl: magnet_link,
        downloadType: 'torrent',
        selectedFileIndices: file_indices ? JSON.stringify(file_indices) : null,
        ...(file_name ? { fileName: file_name } : {}),
      }).returning();
    }

    const id = record.id;
    const guestId = record.guestId ?? null;
    progressMap.set(id, { downloadedBytes: 0, totalBytes: record.fileSize ?? null, percentFixed2: null, percent: null });

    this.svc.streamToCloud(id, magnet_link, { fileName: record.fileName ?? file_name, fileIndices: file_indices, guestId }).catch(console.error);

    return { status: true, message: 'torrent to MEGA started', data: { fileStatusId: id } };
  }
}
