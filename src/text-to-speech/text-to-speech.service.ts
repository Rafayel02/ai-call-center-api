import { BadRequestException, Injectable, Logger, NotFoundException, StreamableFile } from '@nestjs/common';
import { Prisma, TtsProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTextToSpeechModelDto, TestTextToSpeechDraftDto, UpdateTextToSpeechModelDto } from './dto/text-to-speech-model.dto';
import { TtsProviderRegistry } from './providers/provider.registry';
import { TextToSpeechProvider } from './providers/text-to-speech-provider';
import { speechClipKey } from './speech-clip';

@Injectable()
export class TextToSpeechService {
  private readonly logger = new Logger(TextToSpeechService.name);

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
    const provider = this.providers.get(model.provider);
    const config = model.config as Record<string, unknown>;
    const identity = provider.toPublic(config);
    const providerModelId = typeof identity.modelId === 'string' ? identity.modelId : '';
    const voiceId = typeof identity.voiceId === 'string' ? identity.voiceId : '';
    if (!providerModelId || !voiceId) throw new BadRequestException('Stored speech model is incomplete.');
    const cacheKey = speechClipKey({ modelId: model.id, providerModelId, voiceId, text: spoken });

    const cached = await this.prisma.textToSpeechClip.findUnique({
      where: { cacheKey },
      select: { audio: true, mimeType: true },
    });
    if (cached) {
      this.logger.log(`Reused speech clip for model ${model.id}`);
      return this.audioFile(Buffer.from(cached.audio), cached.mimeType);
    }

    const generated = await provider.speak(config, spoken);
    try {
      await this.prisma.textToSpeechClip.create({
        data: {
          modelId: model.id,
          cacheKey,
          providerModelId,
          voiceId,
          text: spoken,
          audio: Uint8Array.from(generated),
          mimeType: 'audio/mpeg',
          byteSize: generated.length,
        },
      });
      this.logger.log(`Stored speech clip for model ${model.id}`);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const winner = await this.prisma.textToSpeechClip.findUnique({
        where: { cacheKey },
        select: { audio: true, mimeType: true },
      });
      if (winner) return this.audioFile(Buffer.from(winner.audio), winner.mimeType);
    }
    return this.audioFile(generated, 'audio/mpeg');
  }

  private audioFile(audio: Buffer, mimeType: string) {
    return new StreamableFile(audio, {
      type: mimeType,
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
