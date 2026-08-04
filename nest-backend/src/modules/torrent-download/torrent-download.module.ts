import { Module } from '@nestjs/common';
import { TorrentDownloadController } from './torrent-download.controller.js';
import { TorrentDownloadService } from './torrent-download.service.js';
import { TorrentMetadataService } from './torrent-metadata.service.js';

@Module({
  controllers: [TorrentDownloadController],
  providers: [TorrentDownloadService, TorrentMetadataService],
})
export class TorrentDownloadModule {}
