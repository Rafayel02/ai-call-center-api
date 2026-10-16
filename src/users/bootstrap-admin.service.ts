import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { hashPassword } from './passwords';

@Injectable()
export class BootstrapAdminService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    const email = this.config.getOrThrow<string>('BOOTSTRAP_ADMIN_EMAIL').trim().toLowerCase();
    const password = this.config.getOrThrow<string>('BOOTSTRAP_ADMIN_PASSWORD');
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      this.logger.log('Bootstrap admin already exists; password was left unchanged.');
      return;
    }

    try {
      await this.prisma.user.create({
        data: {
          email,
          passwordHash: await hashPassword(password),
          role: 'ADMIN',
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        this.logger.log('Bootstrap admin already exists; password was left unchanged.');
        return;
      }
      throw error;
    }
    this.logger.log('Created the initial admin account.');
  }
}
