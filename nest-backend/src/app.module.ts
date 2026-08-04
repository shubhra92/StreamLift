import { Module } from '@nestjs/common';
import { MegaModule } from './modules/mega/mega.module.js';
import { ProgressModule } from './modules/progress/progress.module.js';
import { StreamDownloadModule } from './modules/stream-download/stream-download.module.js';
import { TorrentDownloadModule } from './modules/torrent-download/torrent-download.module.js';

@Module({
  imports: [
    MegaModule,
    ProgressModule,
    StreamDownloadModule,
    TorrentDownloadModule,
  ],
})
export class AppModule {}
