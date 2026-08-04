import { Module } from '@nestjs/common';
import { StreamDownloadController } from './stream-download.controller.js';
import { StreamDownloadService } from './stream-download.service.js';

@Module({
  controllers: [StreamDownloadController],
  providers: [StreamDownloadService],
})
export class StreamDownloadModule {}
