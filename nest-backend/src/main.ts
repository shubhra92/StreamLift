import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors();

  // Health check — before any module middleware
  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/', (_req: any, res: any) => res.send('StreamLift NestJS backend is running ✅'));
  httpAdapter.get('/health', (_req: any, res: any) => res.json({ ready: true }));

  const port = process.env.PORT ?? 4000;
  await app.listen(port);
  console.log(`🚀 NestJS backend running on http://localhost:${port}`);
}

bootstrap();
