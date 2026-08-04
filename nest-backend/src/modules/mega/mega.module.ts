import { Global, Module } from '@nestjs/common';
import { MegaService } from './mega.service.js';

@Global()
@Module({
  providers: [MegaService],
  exports: [MegaService],
})
export class MegaModule {}
