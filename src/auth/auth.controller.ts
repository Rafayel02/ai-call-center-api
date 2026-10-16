import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ACCESS_COOKIE } from './jwt.strategy';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(dto);
    const production = process.env.NODE_ENV === 'production';
    response.cookie(ACCESS_COOKIE, result.accessToken, {
      httpOnly: true,
      secure: production,
      sameSite: production ? 'none' : 'lax',
      path: '/',
      maxAge: 12 * 60 * 60 * 1000,
    });
    return { user: result.user };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response) {
    const production = process.env.NODE_ENV === 'production';
    response.clearCookie(ACCESS_COOKIE, {
      httpOnly: true,
      secure: production,
      sameSite: production ? 'none' : 'lax',
      path: '/',
    });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Get('session')
  session(@Req() request: Request) {
    return { authenticated: Boolean(request.cookies?.[ACCESS_COOKIE]) };
  }
}
