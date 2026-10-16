import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { hashPassword } from './passwords';

const publicUser = {
  id: true,
  email: true,
  role: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.user.findMany({
      select: publicUser,
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(dto: CreateUserDto) {
    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException('Passwords do not match.');
    }
    const email = dto.email.trim().toLowerCase();
    try {
      return await this.prisma.user.create({
        data: {
          email,
          passwordHash: await hashPassword(dto.password),
          role: 'ADMIN',
        },
        select: publicUser,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An account with that email already exists.');
      }
      throw error;
    }
  }
}
