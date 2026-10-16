import { BadRequestException, Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Prisma, TtsProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTextToSpeechModelDto, TestTextToSpeechDraftDto, UpdateTextToSpeechModelDto } from './dto/text-to-speech-model.dto';
import { TtsProviderRegistry } from './providers/provider.registry';
import { TextToSpeechProvider } from './providers/text-to-speech-provider';

@Injectable()
export class TextToSpeechService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: TtsProviderRegistry,
  ) {}

  providersAvailable() {
    return this.providers.list();
  }

  async list() {
    const models = await this.prisma.textToSpeechModel.findMany({
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    return models.map((model) => this.present(model));
  }

  async get(id: string) {
    return this.present(await this.findOrThrow(id));
  }

  async create(dto: CreateTextToSpeechModelDto, userId: string) {
    const provider = this.providers.get(dto.provider);
    const config = await provider.validateCreate(dto.config);
    const model = await this.prisma.textToSpeechModel.create({
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

  async update(id: string, dto: UpdateTextToSpeechModelDto) {
    const existing = await this.findOrThrow(id);
    const provider = this.providers.get(existing.provider);
    const config = dto.config
      ? await provider.validateUpdate(dto.config, existing.config as Record<string, unknown>)
      : undefined;
    const model = await this.prisma.textToSpeechModel.update({
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
    await this.prisma.textToSpeechModel.delete({ where: { id } });
    return { ok: true };
  }

  async testStored(id: string) {
    const model = await this.findOrThrow(id);
    const provider = this.providers.get(model.provider);
    return this.runTest(provider, model.config as Record<string, unknown>);
  }

  async testDraft(dto: TestTextToSpeechDraftDto) {
    const provider = this.providers.get(dto.provider);
    if (!provider.supportsConnectionTest || !provider.testDraft) {
      throw new BadRequestException('This provider has no connection check.');
    }
    return provider.testDraft(dto.config);
  }

  voicesForDraft(dto: TestTextToSpeechDraftDto) {
    return this.providers.get(dto.provider).listVoices(dto.config).then((voices) => ({ voices }));
  }

  async voicesForStored(id: string) {
    const model = await this.findOrThrow(id);
    const voices = await this.providers.get(model.provider).listStoredVoices(model.config as Record<string, unknown>);
    return { voices };
  }

  async speak(id: string, text: string) {
    const spoken = text.trim();
    if (!spoken) throw new BadRequestException('Enter the text to speak.');
    if (spoken.length > 5000) throw new BadRequestException('Text can be at most 5000 characters.');
    const model = await this.findOrThrow(id);
    if (!model.enabled) throw new BadRequestException('This model is disabled.');
    const audio = await this.providers.get(model.provider).speak(model.config as Record<string, unknown>, spoken);
    return new StreamableFile(audio, {
      type: 'audio/mpeg',
      disposition: 'inline; filename="speech.mp3"',
    });
  }

  private runTest(provider: TextToSpeechProvider, config: Record<string, unknown>) {
    if (!provider.supportsConnectionTest || !provider.test) {
      throw new BadRequestException('This provider has no connection check.');
    }
    return provider.test(config);
  }

  private async findOrThrow(id: string) {
    const model = await this.prisma.textToSpeechModel.findUnique({
      where: { id },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    if (!model) throw new NotFoundException('Text-to-speech model not found.');
    return model;
  }

  private present(model: {
    id: string;
    name: string;
    provider: TtsProvider;
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
