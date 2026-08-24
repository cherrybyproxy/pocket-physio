import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // enable validation pipe globally so all dtos are validated automatically
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,       // strip properties not in the dto
      forbidNonWhitelisted: true,
      transform: true,       // auto-transform payloads to dto instances
    }),
  );

  // cors: allow the vite dev server and the deployed frontend origin.
  // TODO(security): restrict to exact production origin once deployed.
  const allowedOrigins = process.env['CORS_ORIGIN']
    ? process.env['CORS_ORIGIN'].split(',')
    : ['http://localhost:5173'];

  app.enableCors({
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  });

  const port = process.env['PORT'] ?? 3000;
  // listen on localhost only for local dev; render handles binding in production
  const host = process.env['NODE_ENV'] === 'production' ? '0.0.0.0' : '127.0.0.1';
  await app.listen(port, host);
}
bootstrap();
