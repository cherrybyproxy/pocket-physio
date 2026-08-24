// auth service — handles registration, login, and jwt signing.
// passwords are hashed with bcrypt. jwt secret is loaded from environment
// with a secure fallback for local dev.

import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async register(email: string, password: string): Promise<{ access_token: string }> {
    // check for duplicate email
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('email already registered');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await this.prisma.user.create({
      data: { email, passwordHash },
    });

    return this.signToken(user.id, user.email);
  }

  async login(email: string, password: string): Promise<{ access_token: string }> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('invalid credentials');
    }

    return this.signToken(user.id, user.email);
  }

  private signToken(userId: string, email: string): { access_token: string } {
    const payload = { sub: userId, email };
    return { access_token: this.jwt.sign(payload) };
  }
}
