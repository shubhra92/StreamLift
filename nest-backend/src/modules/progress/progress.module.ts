import { Module } from '@nestjs/common';
import { ProgressController } from './progress.controller.js';

@Module({
  controllers: [ProgressController],
})
export class ProgressModule {}
