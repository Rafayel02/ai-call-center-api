import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SttProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSpeechModelDto, TestDraftDto, UpdateSpeechModelDto } from './dto/speech-model.dto';
import { ProviderRegistry } from './providers/provider.registry';
import { SpeechToTextProvider } from './providers/speech-to-text-provider';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

@Injectable()
export class SpeechToTextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
  ) {}

  providersAvailable() {
    return this.providers.list();
  }

  async list() {
    const models = await this.prisma.speechToTextModel.findMany({
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    return models.map((model) => this.present(model));
  }

  async get(id: string) {
    return this.present(await this.findOrThrow(id));
  }

  async create(dto: CreateSpeechModelDto, userId: string) {
    const provider = this.providers.get(dto.provider);
    const config = provider.validateCreate(dto.config);
    const model = await this.prisma.speechToTextModel.create({
      data: {
        name: dto.name.trim(),
        provider: dto.provider,
        enabled: dto.enabled ?? true,
        config: config as Prisma.InputJsonValue,
        createdById: userId,
      },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    return this.present(model);
  }

  async update(id: string, dto: UpdateSpeechModelDto) {
    const existing = await this.findOrThrow(id);
    const provider = this.providers.get(existing.provider);
    const config = dto.config
      ? provider.validateUpdate(dto.config, existing.config as Record<string, unknown>)
      : undefined;
    const model = await this.prisma.speechToTextModel.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        enabled: dto.enabled,
        config: config as Prisma.InputJsonValue | undefined,
      },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    return this.present(model);
  }

  async remove(id: string) {
    await this.findOrThrow(id);
    await this.prisma.speechToTextModel.delete({ where: { id } });
    return { ok: true };
  }

  async testStored(id: string) {
    const model = await this.findOrThrow(id);
    const provider = this.providers.get(model.provider);
    return this.runTest(provider, model.config as Record<string, unknown>);
  }

  async transcribe(id: string, file?: { buffer?: Buffer; size?: number; mimetype?: string; originalname?: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('Choose an audio file.');
    if ((file.size ?? file.buffer.length) > MAX_AUDIO_BYTES) {
      throw new BadRequestException('Audio file must be 25 MB or smaller.');
    }
    const mimeType = file.mimetype || 'application/octet-stream';
    if (!/^(audio\/|video\/|application\/octet-stream)/.test(mimeType)) {
      throw new BadRequestException('Upload an audio file.');
    }
    const model = await this.findOrThrow(id);
    if (!model.enabled) throw new BadRequestException('This model is disabled.');
    const filename = (file.originalname || 'audio').replace(/[^\w.\-]+/g, '_').slice(0, 120);
    return this.providers.get(model.provider).transcribe(model.config as Record<string, unknown>, {
      buffer: file.buffer,
      filename,
      mimeType,
    });
  }

  async testDraft(dto: TestDraftDto) {
    const provider = this.providers.get(dto.provider);
    const config = provider.validateCreate(dto.config);
    return this.runTest(provider, config);
  }

  private runTest(provider: SpeechToTextProvider, config: Record<string, unknown>) {
    if (!provider.supportsConnectionTest || !provider.test) {
      throw new BadRequestException('This provider has no connection check.');
    }
    return provider.test(config);
  }

  private async findOrThrow(id: string) {
    const model = await this.prisma.speechToTextModel.findUnique({
      where: { id },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    if (!model) throw new NotFoundException('Speech-to-text model not found.');
    return model;
  }

  private present(model: {
    id: string;
    name: string;
    provider: SttProvider;
    enabled: boolean;
    config: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
    createdBy: { id: string; email: string };
  }) {
    const provider = this.providers.get(model.provider);
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      enabled: model.enabled,
      config: provider.toPublic(model.config as Record<string, unknown>),
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
      createdBy: model.createdBy,
    };
  }
}
