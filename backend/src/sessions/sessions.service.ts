// sessions service — creates and lists therapy sessions for a given user.
// stores date, time (military + timezone), injuredSide, minAngle, maxAngle, rom, bodyLeanMax.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSessionDto } from './sessions.dto';

@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateSessionDto) {
    return this.prisma.session.create({
      data: {
        userId,
        date: dto.date,
        time: dto.time,
        injuredSide: dto.injuredSide,
        minAngle: dto.minAngle,
        maxAngle: dto.maxAngle,
        rom: dto.rom,
        bodyLeanMax: dto.bodyLeanMax ?? 0,
      },
    });
  }

  async findAllByUser(userId: string) {
    return this.prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
