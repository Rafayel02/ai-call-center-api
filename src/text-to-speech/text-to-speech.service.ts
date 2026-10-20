import { BadRequestException, Injectable, Logger, NotFoundException, StreamableFile } from '@nestjs/common';
import { Prisma, TtsProvider } from '@prisma/client';
import { ModelPricingService } from '../model-pricing/model-pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionContext } from '../scenario-executions/execution-context';
import { speechGenerationUsd } from '../scenario-executions/execution-price';
import { ScenarioExecutionsService } from '../scenario-executions/scenario-executions.service';
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
    private readonly executions: ScenarioExecutionsService,
    private readonly pricing: ModelPricingService,
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

  async listClips() {
    const clips = await this.prisma.textToSpeechClip.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        text: true,
        providerModelId: true,
        voiceId: true,
        priceUsd: true,
        createdAt: true,
        model: { select: { name: true, provider: true, config: true } },
      },
    });
    return clips.map((clip) => ({
      id: clip.id,
      text: clip.text,
      characters: clip.text.length,
      modelName: clip.model.name,
      provider: clip.model.provider,
      providerModel: clip.providerModelId,
      voiceName: voiceLabel(clip.model.config, clip.voiceId),
      priceUsd: clip.priceUsd == null ? null : Number(clip.priceUsd.toString()),
      createdAt: clip.createdAt,
    }));
  }

  async speak(id: string, text: string, execution: ExecutionContext | null = null) {
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
    const voiceName = typeof identity.voiceName === 'string' ? identity.voiceName : '';
    if (!providerModelId || !voiceId) throw new BadRequestException('Stored speech model is incomplete.');
    const snapshot = {
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
      providerModel: providerModelId,
      voiceId,
      voiceName,
    };
    const started = Date.now();
    try {
      const clip = await this.loadOrCreateClip(model.id, provider, config, providerModelId, voiceId, spoken);
      await this.executions.recordSpeech(execution, {
        model: snapshot,
        text: spoken,
        latencyMs: Date.now() - started,
        audio: clip.audio,
        mimeType: clip.mimeType,
        cached: clip.cached,
      });
      return this.audioFile(clip.audio, clip.mimeType);
    } catch (error) {
      await this.executions.recordSpeech(execution, {
        model: snapshot,
        text: spoken,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : 'Speech failed.',
      });
      throw error;
    }
  }

  private async loadOrCreateClip(
    modelId: string,
    provider: TextToSpeechProvider,
    config: Record<string, unknown>,
    providerModelId: string,
    voiceId: string,
    spoken: string,
  ) {
    const cacheKey = speechClipKey({ modelId, providerModelId, voiceId, text: spoken });
    const cached = await this.prisma.textToSpeechClip.findUnique({
      where: { cacheKey },
      select: { audio: true, mimeType: true },
    });
    if (cached) {
      this.logger.log(`Reused speech clip for model ${modelId}`);
      return { audio: Buffer.from(cached.audio), mimeType: cached.mimeType, cached: true };
    }

    const generated = await provider.speak(config, spoken);
    try {
      const clip = await this.prisma.textToSpeechClip.create({
        data: {
          modelId,
          cacheKey,
          providerModelId,
          voiceId,
          text: spoken,
          audio: Uint8Array.from(generated),
          mimeType: 'audio/mpeg',
          byteSize: generated.length,
        },
        select: { id: true },
      });
      this.logger.log(`Stored speech clip for model ${modelId}`);
      void this.rememberClipPrice(clip.id, providerModelId, spoken);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const winner = await this.prisma.textToSpeechClip.findUnique({
        where: { cacheKey },
        select: { audio: true, mimeType: true },
      });
      if (winner) return { audio: Buffer.from(winner.audio), mimeType: winner.mimeType, cached: false };
    }
    return { audio: generated, mimeType: 'audio/mpeg', cached: false };
  }

  private async rememberClipPrice(id: string, providerModelId: string, spoken: string) {
    try {
      const usd = speechGenerationUsd('ELEVENLABS', providerModelId, spoken, await this.pricing.rates());
      if (usd == null) return;
      await this.prisma.textToSpeechClip.updateMany({
        where: { id, priceUsd: null },
        data: { priceUsd: usd.toFixed(6) },
      });
    } catch (error) {
      this.logger.warn(`Could not store the first cost of speech clip ${id}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
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

function voiceLabel(config: Prisma.JsonValue, voiceId: string) {
  const record = config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  if (record.voiceId === voiceId && typeof record.voiceName === 'string' && record.voiceName.trim()) return record.voiceName;
  return voiceId;
}
