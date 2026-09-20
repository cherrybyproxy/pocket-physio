import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [PrismaModule, AuthModule, SessionsModule],
  controllers: [AppController],
})
export class AppModule {}
