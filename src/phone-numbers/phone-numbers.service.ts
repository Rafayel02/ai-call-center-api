import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePhoneNumberDto, UpdatePhoneNumberDto } from './dto/phone-number.dto';

const numberSelect = {
  id: true,
  e164: true,
  createdAt: true,
  updatedAt: true,
  scenario: { select: { id: true, name: true, active: true, organization: { select: { name: true } } } },
} satisfies Prisma.PhoneNumberSelect;

/** The numbers callers dial. Each runs exactly one published scenario. */
@Injectable()
export class PhoneNumbersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.phoneNumber.findMany({ select: numberSelect, orderBy: { createdAt: 'desc' } });
  }

  async create(dto: CreatePhoneNumberDto) {
    await this.assertPublished(dto.scenarioId);
    return this.save(() => this.prisma.phoneNumber.create({ data: { e164: dto.e164, scenarioId: dto.scenarioId }, select: numberSelect }));
  }

  async update(id: string, dto: UpdatePhoneNumberDto) {
    await this.findOrThrow(id);
    if (dto.scenarioId) await this.assertPublished(dto.scenarioId);
    return this.save(() =>
      this.prisma.phoneNumber.update({
        where: { id },
        data: { ...(dto.e164 ? { e164: dto.e164 } : {}), ...(dto.scenarioId ? { scenarioId: dto.scenarioId } : {}) },
        select: numberSelect,
      }),
    );
  }

  /** Past calls keep their row; they just lose the link to the number. */
  async remove(id: string) {
    await this.findOrThrow(id);
    await this.prisma.phoneNumber.delete({ where: { id } });
    return { ok: true };
  }

  private async assertPublished(scenarioId: string) {
    const scenario = await this.prisma.scenario.findUnique({ where: { id: scenarioId }, select: { active: true } });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    if (!scenario.active) throw new BadRequestException('Publish the scenario before giving it a number.');
  }

  private async findOrThrow(id: string) {
    const row = await this.prisma.phoneNumber.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new NotFoundException('Phone number not found.');
    return row;
  }

  private async save<T>(write: () => Promise<T>) {
    try {
      return await write();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That number is already added.');
      }
      throw error;
    }
  }
}
