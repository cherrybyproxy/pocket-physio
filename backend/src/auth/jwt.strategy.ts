// jwt strategy — extracts and validates jwt from the authorization header.
// rejects tokens with 'none' algorithm (handled by passport-jwt defaults).
// the expected algorithm is hardcoded to HS256 to prevent algorithm confusion.

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { getJwtSecret } from './jwt-secret';

interface JwtPayload {
  sub: string;
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(),
      algorithms: ['HS256'], // reject 'none' and other algorithms
    });
  }

  validate(payload: JwtPayload): { userId: string; email: string } {
    if (!payload.sub) {
      throw new UnauthorizedException();
    }
    return { userId: payload.sub, email: payload.email };
  }
}
