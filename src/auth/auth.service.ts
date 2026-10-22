import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { verifyPassword } from '../users/passwords';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    const valid = user ? await verifyPassword(dto.password, user.passwordHash) : false;
    if (!user || !valid) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const accessToken = await this.signAccess({ id: user.id, email: user.email, role: user.role }, '12h');

    return {
      accessToken,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  signAccess(user: AuthUser, expiresIn: '5m' | '12h') {
    return this.jwt.signAsync({ sub: user.id, email: user.email, role: user.role }, { expiresIn });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, createdAt: true },
    });
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
