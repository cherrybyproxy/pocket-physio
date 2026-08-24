// sessions controller — create and list endpoints, guarded by jwt auth.
// the user id is extracted from the validated jwt payload on the request.

import { Controller, Post, Get, Body, UseGuards, Req } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { CreateSessionDto } from './sessions.dto';
import { JwtGuard } from '../auth/jwt.guard';
import { Request } from 'express';

interface AuthenticatedRequest extends Request {
  user: { userId: string; email: string };
}

@Controller('api/sessions')
@UseGuards(JwtGuard)
export class SessionsController {
  constructor(private readonly sessionsService: SessionsService) {}

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() dto: CreateSessionDto) {
    return this.sessionsService.create(req.user.userId, dto);
  }

  @Get()
  async findAll(@Req() req: AuthenticatedRequest) {
    return this.sessionsService.findAllByUser(req.user.userId);
  }
}
