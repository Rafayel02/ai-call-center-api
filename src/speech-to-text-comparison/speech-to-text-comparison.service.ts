import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../speech-to-text/providers/provider.registry';
import { SpeechToTextProvider } from '../speech-to-text/providers/speech-to-text-provider';
import { PreviewComparisonDto, RunCheckDto } from './dto/comparison.dto';
import { pickSamples } from './sample-selection';
import { scoreTranscript } from './transcript-score';

const sampleFields = { id: true, sentence: true, age: true, gender: true } as const;
const sampleOrder = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
const storedFields = { engineKey: true, sampleId: true, transcript: true, languageCode: true } as const;

type StoredCheck = Prisma.SpeechToTextResultGetPayload<{ select: typeof storedFields }>;

function checkKey(engineKey: string, sampleId: string) {
  return `${engineKey}\0${sampleId}`;
}

@Injectable()
export class SpeechToTextComparisonService {
  private readonly logger = new Logger(SpeechToTextComparisonService.name);
  private readonly inFlight = new Map<string, Promise<StoredCheck>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
  ) {}

  async preview(dto: PreviewComparisonDto) {
    if ((dto.sampleIds === undefined) === (dto.count === undefined)) {
      throw new BadRequestException('Send either the samples to compare or how many to pick.');
    }
    const models = await this.loadModels(dto.modelIds);
    const engineKeys = [...new Set(models.map((model) => model.engineKey))];

    let sampleIds = dto.sampleIds ? [...new Set(dto.sampleIds)] : [];
    if (dto.count !== undefined) {
      const [all, stored] = await Promise.all([
        this.prisma.datasetSample.findMany({ orderBy: sampleOrder, select: { id: true } }),
        this.prisma.speechToTextResult.findMany({
          where: { engineKey: { in: engineKeys } },
          select: { engineKey: true, sampleId: true },
        }),
      ]);
      sampleIds = pickSamples(
        all.map((sample) => sample.id),
        engineKeys,
        stored,
        dto.count,
      );
    }

    const samples = await this.prisma.datasetSample.findMany({
      where: { id: { in: sampleIds } },
      orderBy: sampleOrder,
      select: sampleFields,
    });
    if (samples.length !== sampleIds.length) throw new NotFoundException('Some dataset samples no longer exist.');

    const stored = await this.prisma.speechToTextResult.findMany({
      where: { engineKey: { in: engineKeys }, sampleId: { in: sampleIds } },
      select: storedFields,
    });
    const byCheck = new Map(stored.map((result) => [checkKey(result.engineKey, result.sampleId), result]));

    const results = [];
    const missing = new Set<string>();
    for (const sample of samples) {
      for (const model of models) {
        const key = checkKey(model.engineKey, sample.id);
        const result = byCheck.get(key);
        if (result) results.push(this.present(model.id, sample.sentence, result));
        else missing.add(key);
      }
    }

    return {
      models: models.map(({ id, name, provider, engineKey }) => ({ id, name, provider, engineKey })),
      samples,
      results,
      newChecks: missing.size,
    };
  }

  async check(dto: RunCheckDto) {
    const model = await this.prisma.speechToTextModel.findUnique({ where: { id: dto.modelId } });
    if (!model) throw new NotFoundException('Speech-to-text model not found.');
    if (!model.enabled) throw new BadRequestException('This model is disabled.');
    const sample = await this.prisma.datasetSample.findUnique({
      where: { id: dto.sampleId },
      select: { id: true, sentence: true },
    });
    if (!sample) throw new NotFoundException('Dataset sample not found.');

    const provider = this.providers.get(model.provider);
    const config = model.config as Record<string, unknown>;
    const engineKey = provider.engineKey(config);
    const stored = await this.findStored(engineKey, sample.id);
    if (stored) return { ...this.present(model.id, sample.sentence, stored), reused: true };

    const key = checkKey(engineKey, sample.id);
    const running = this.inFlight.get(key);
    if (running) return { ...this.present(model.id, sample.sentence, await running), reused: true };

    const pending = this.transcribeAndStore(provider, config, engineKey, sample.id).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return { ...this.present(model.id, sample.sentence, await pending), reused: false };
  }

  private async transcribeAndStore(
    provider: SpeechToTextProvider,
    config: Record<string, unknown>,
    engineKey: string,
    sampleId: string,
  ): Promise<StoredCheck> {
    const audio = await this.prisma.datasetSample.findUnique({
      where: { id: sampleId },
      select: { audio: true, mimeType: true, filename: true },
    });
    if (!audio) throw new NotFoundException('Dataset sample not found.');

    const transcript = await provider.transcribe(config, {
      buffer: Buffer.from(audio.audio),
      filename: audio.filename,
      mimeType: audio.mimeType,
    });
    try {
      const created = await this.prisma.speechToTextResult.create({
        data: { engineKey, sampleId, transcript: transcript.text, languageCode: transcript.languageCode },
        select: storedFields,
      });
      this.logger.log(`Stored check ${engineKey} for sample ${sampleId}`);
      return created;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const winner = await this.findStored(engineKey, sampleId);
      if (!winner) throw error;
      return winner;
    }
  }

  private findStored(engineKey: string, sampleId: string) {
    return this.prisma.speechToTextResult.findUnique({
      where: { engineKey_sampleId: { engineKey, sampleId } },
      select: storedFields,
    });
  }

  private async loadModels(ids: string[]) {
    const unique = [...new Set(ids)];
    const models = await this.prisma.speechToTextModel.findMany({ where: { id: { in: unique } } });
    if (models.length !== unique.length) throw new NotFoundException('Some speech-to-text models no longer exist.');
    const byId = new Map(models.map((model) => [model.id, model]));
    return unique.map((id) => {
      const model = byId.get(id)!;
      const engineKey = this.providers.get(model.provider).engineKey(model.config as Record<string, unknown>);
      return { id: model.id, name: model.name, provider: model.provider, engineKey };
    });
  }

  private present(modelId: string, sentence: string, result: StoredCheck) {
    return {
      modelId,
      sampleId: result.sampleId,
      transcript: result.transcript,
      languageCode: result.languageCode,
      accuracy: scoreTranscript(sentence, result.transcript),
    };
  }
}
