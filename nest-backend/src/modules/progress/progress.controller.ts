import { Controller, Get, Param, Res, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { progressMap } from '../../common/progress.store.js';

@Controller('progress')
export class ProgressController {
  /** GET /api/progress/:id  — single poll */
  @Get(':id')
  getProgress(@Param('id') id: string, @Res() res: Response) {
    const progress = progressMap.get(id);
    if (!progress) {
      throw new NotFoundException({ details: 'Progress not found', fileId: id });
    }

    res.json(progress);

    if (progress.done) {
      setTimeout(() => progressMap.delete(id), 60_000);
    }
  }

  /** GET /api/progress/:id/stream  — SSE live stream */
  @Get(':id/stream')
  streamProgress(@Param('id') id: string, @Res() res: Response) {
    const progress = progressMap.get(id);
    if (!progress) {
      throw new NotFoundException({ details: 'Progress not found', fileId: id });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    let isFirst = true;

    const interval = setInterval(() => {
      const current = isFirst ? progress : progressMap.get(id);
      isFirst = false;

      if (current) {
        res.write(`data: ${JSON.stringify(current)}\n\n`);
        if (current.done) {
          clearInterval(interval);
          res.end();
        }
      }
    }, 1000);

    res.on('close', () => clearInterval(interval));
  }
}
