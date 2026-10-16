import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const origins = config
    .getOrThrow<string>('FRONTEND_URL')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.setGlobalPrefix('');
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: origins,
    credentials: true,
  });
  app.use((request: { method: string; headers: { origin?: string } }, response: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
    const origin = request.headers.origin;
    if (origin && !origins.includes(origin) && request.method !== 'GET' && request.method !== 'OPTIONS') {
      response.status(403).json({ statusCode: 403, message: 'Origin is not allowed.' });
      return;
    }
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
