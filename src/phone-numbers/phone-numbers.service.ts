import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePhoneNumberDto, UpdatePhoneNumberDto } from './dto/phone-number.dto';

const numberSelect = {
  id: true,
  e164: true,
  createdAt: true,
  updatedAt: true,
  streamingService: { select: { id: true, name: true, provider: true } },
  scenario: { select: { id: true, name: true } },
} satisfies Prisma.PhoneNumberSelect;

@Injectable()
export class PhoneNumbersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.phoneNumber.findMany({ select: numberSelect, orderBy: { createdAt: 'desc' } });
  }

  /** Numbers a scenario may choose: free ones, plus the number already on that scenario. */
  available(scenarioId: string) {
    return this.prisma.phoneNumber.findMany({
      where: { OR: [{ scenarioId: null }, { scenarioId }] },
      select: numberSelect,
      orderBy: { e164: 'asc' },
    });
  }

  async create(dto: CreatePhoneNumberDto) {
    await this.assertService(dto.streamingServiceId);
    return this.save(() =>
      this.prisma.phoneNumber.create({
        data: { e164: dto.e164, streamingServiceId: dto.streamingServiceId },
        select: numberSelect,
      }),
    );
  }

  async update(id: string, dto: UpdatePhoneNumberDto) {
    await this.findOrThrow(id);
    if (dto.streamingServiceId) await this.assertService(dto.streamingServiceId);
    return this.save(() =>
      this.prisma.phoneNumber.update({
        where: { id },
        data: {
          ...(dto.e164 ? { e164: dto.e164 } : {}),
          ...(dto.streamingServiceId ? { streamingServiceId: dto.streamingServiceId } : {}),
        },
        select: numberSelect,
      }),
    );
  }

  async remove(id: string) {
    const number = await this.prisma.phoneNumber.findUnique({ where: { id }, select: { scenarioId: true } });
    if (!number) throw new NotFoundException('Phone number not found.');
    if (number.scenarioId) throw new BadRequestException('Detach this number from its scenario before deleting it.');
    await this.prisma.phoneNumber.delete({ where: { id } });
    return { ok: true };
  }

  private async assertService(id: string) {
    const service = await this.prisma.phoneStreamingService.findUnique({ where: { id }, select: { id: true } });
    if (!service) throw new NotFoundException('Phone streaming service not found.');
  }

  private async findOrThrow(id: string) {
    const row = await this.prisma.phoneNumber.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new NotFoundException('Phone number not found.');
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
