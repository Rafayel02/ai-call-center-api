import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

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

  async list() {
    const organizations = await this.prisma.organization.findMany({
      select: {
        ...publicOrganization,
        _count: { select: { scenarios: true } },
        scenarios: { where: { active: true }, select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return organizations.map(({ _count, scenarios, ...organization }) => ({
      ...organization,
      scenarioCount: _count.scenarios,
      activeScenarioCount: scenarios.length,
    }));
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

  async update(id: string, dto: UpdateOrganizationDto) {
    const data: Prisma.OrganizationUpdateInput = {};
    if (dto.name !== undefined) {
      data.name = dto.name;
      data.nameKey = organizationNameKey(dto.name);
    }
    if (dto.description !== undefined) data.description = dto.description;
    try {
      return await this.prisma.organization.update({
        where: { id },
        data,
        select: publicOrganization,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An organization with that name already exists.');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Organization not found.');
      }
      throw error;
    }
  }

  async remove(id: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id },
      select: { id: true, scenarios: { where: { active: true }, select: { id: true } } },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
    if (organization.scenarios.length > 0) {
      throw new ConflictException('Unpublish every scenario before deleting this organization.');
    }
    await this.prisma.$transaction([
      this.prisma.scenario.deleteMany({ where: { organizationId: id } }),
      this.prisma.organization.delete({ where: { id } }),
    ]);
    return { ok: true };
  }
}
