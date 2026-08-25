import { Module, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { MegaModule } from './modules/mega/mega.module.js';
import { ProgressModule } from './modules/progress/progress.module.js';
import { StreamDownloadModule } from './modules/stream-download/stream-download.module.js';
import { TorrentDownloadModule } from './modules/torrent-download/torrent-download.module.js';
import { FileInfoModule } from './modules/file-info/file-info.module.js';
import { db, fileDownloads } from './db/index.js';
import { eq } from 'drizzle-orm';

@Module({
  imports: [
    MegaModule,
    ProgressModule,
    StreamDownloadModule,
    TorrentDownloadModule,
    FileInfoModule,
  ],
})
export class AppModule implements OnApplicationBootstrap {
  private readonly logger = new Logger('AppModule');

  async onApplicationBootstrap() {
    try {
      const stale = await db
        .update(fileDownloads)
        .set({
          status: 'failed',
          errorMessage: 'Server restarted while download was in progress',
          updatedAt: new Date(),
        })
        .where(eq(fileDownloads.status, 'downloading'))
        .returning({ id: fileDownloads.id });

      if (stale.length > 0) {
        this.logger.warn(`[startup] Marked ${stale.length} stale download(s) as failed: ${stale.map(r => r.id).join(', ')}`);
      }
    } catch (err: any) {
      this.logger.error('[startup] Failed to recover stale downloads: ' + err.message);
    }
  }
}
