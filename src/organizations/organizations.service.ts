import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';

const publicOrganization = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
} satisfies Prisma.OrganizationSelect;

export function organizationNameKey(name: string) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.organization.findMany({
      select: publicOrganization,
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: CreateOrganizationDto, createdById: string) {
    try {
      return await this.prisma.organization.create({
        data: {
          name: dto.name,
          nameKey: organizationNameKey(dto.name),
          description: dto.description ?? null,
          createdById,
        },
        select: publicOrganization,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An organization with that name already exists.');
      }
      throw error;
    }
  }
}
