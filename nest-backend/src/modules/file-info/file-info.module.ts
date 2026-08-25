import { Module } from '@nestjs/common';
import { FileInfoController } from './file-info.controller.js';

@Module({
  controllers: [FileInfoController],
})
export class FileInfoModule {}