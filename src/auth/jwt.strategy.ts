import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '../common/decorators/current-user.decorator';

export const ACCESS_COOKIE = 'access_token';

interface JwtPayload {
  sub: string;
  email: string;
  role: AuthUser['role'];
}

function tokenFromRequest(request: Request): string | null {
  const cookie = request?.cookies?.[ACCESS_COOKIE];
  if (typeof cookie === 'string' && cookie.length > 0) return cookie;
  return null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        tokenFromRequest,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: JwtPayload): AuthUser {
    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
