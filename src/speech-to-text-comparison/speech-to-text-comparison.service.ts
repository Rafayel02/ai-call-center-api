import { BadRequestException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, SttCheckStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderRegistry } from '../speech-to-text/providers/provider.registry';
import { SpeechToTextProvider } from '../speech-to-text/providers/speech-to-text-provider';
import { MAX_RUN, PreviewComparisonDto, RunCheckDto } from './dto/comparison.dto';
import { scoreTranscript } from './transcript-score';

/** A model whose last this-many attempts all failed needs review before it spends again. */
const FAILURES_BEFORE_REVIEW = 3;
const RECENT_FAILURES = 5;

const sampleFields = { id: true, sentence: true, age: true, gender: true } as const;
const sampleOrder = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
const storedFields = {
  engineKey: true,
  sampleId: true,
  status: true,
  transcript: true,
  languageCode: true,
  error: true,
  lastAttemptAt: true,
} as const;

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
    if (dto.modelIds.length === 0) throw new BadRequestException('Choose at least one model.');
    if (dto.count !== undefined && (!Number.isInteger(dto.count) || dto.count < 1 || dto.count > MAX_RUN)) {
      throw new BadRequestException(`Choose from 1 to ${MAX_RUN} samples per model.`);
    }
    if (dto.sampleIds !== undefined && (dto.sampleIds.length === 0 || dto.sampleIds.length > MAX_RUN)) {
      throw new BadRequestException(`Choose from 1 to ${MAX_RUN} samples.`);
    }
    const models = await this.loadModels(dto.modelIds);
    const engineKeys = [...new Set(models.map((model) => model.engineKey))];

    let sampleIds = dto.sampleIds ? [...new Set(dto.sampleIds)] : [];
    // Automatic mode: each engine checks only its own batch. Manual mode: every engine checks every sample.
    let batches: Map<string, Set<string>> | null = null;
    if (dto.count !== undefined) {
      const count = dto.count;
      batches = new Map(
        await Promise.all(
          engineKeys.map(async (engineKey) => [engineKey, new Set(await this.nextBatch(engineKey, count))] as const),
        ),
      );
      sampleIds = [...new Set([...batches.values()].flatMap((batch) => [...batch]))];
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
    // One check per engine and sample without a stored success, sent with the first selected model of that engine.
    const checks: { modelId: string; sampleId: string; retry: boolean }[] = [];
    const planned = new Set<string>();
    for (const sample of samples) {
      for (const model of models) {
        const key = checkKey(model.engineKey, sample.id);
        const result = byCheck.get(key);
        if (result) results.push(this.present(model.id, sample.sentence, result));
        if (result?.status === SttCheckStatus.SUCCEEDED || planned.has(key)) continue;
        if (batches && !batches.get(model.engineKey)?.has(sample.id)) continue;
        planned.add(key);
        checks.push({ modelId: model.id, sampleId: sample.id, retry: result !== undefined });
      }
    }
    if (checks.length > MAX_RUN) {
      throw new BadRequestException(
        `This run needs ${checks.length} new checks. A run can send at most ${MAX_RUN}. Choose a smaller count or fewer models.`,
      );
    }

    return {
      models: await Promise.all(
        models.map(async ({ id, name, provider, engineKey }) => ({
          id,
          name,
          provider,
          engineKey,
          ...(await this.reviewState(id)),
        })),
      ),
      samples,
      results,
      checks,
      newChecks: checks.length,
      retries: checks.filter((check) => check.retry).length,
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
    if (stored?.status === SttCheckStatus.SUCCEEDED) {
      return { ...this.present(model.id, sample.sentence, stored), reused: true };
    }

    const key = checkKey(engineKey, sample.id);
    const running = this.inFlight.get(key);
    if (running) return { ...this.present(model.id, sample.sentence, await running), reused: true };

    const pending = this.transcribeAndStore(provider, config, engineKey, sample.id, model.id).finally(() => {
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
    modelId: string,
  ): Promise<StoredCheck> {
    const audio = await this.prisma.datasetSample.findUnique({
      where: { id: sampleId },
      select: { audio: true, mimeType: true, filename: true },
    });
    if (!audio) throw new NotFoundException('Dataset sample not found.');

    let transcript: Awaited<ReturnType<SpeechToTextProvider['transcribe']>>;
    try {
      transcript = await provider.transcribe(config, {
        buffer: Buffer.from(audio.audio),
        filename: audio.filename,
        mimeType: audio.mimeType,
      });
    } catch (error) {
      const reason =
        error instanceof HttpException ? error.message : 'The speech-to-text provider failed unexpectedly.';
      await this.storeFailure(engineKey, sampleId, modelId, reason);
      throw error;
    }
    try {
      const created = await this.prisma.speechToTextResult.create({
        data: {
          engineKey,
          sampleId,
          modelId,
          status: SttCheckStatus.SUCCEEDED,
          transcript: transcript.text,
          languageCode: transcript.languageCode,
        },
        select: storedFields,
      });
      this.logger.log(`Stored check ${engineKey} for sample ${sampleId}`);
      return created;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      // A success replaces a stored failure. If another request already stored a success, that one is kept.
      await this.prisma.speechToTextResult.updateMany({
        where: { engineKey, sampleId, status: SttCheckStatus.FAILED },
        data: {
          modelId,
          status: SttCheckStatus.SUCCEEDED,
          transcript: transcript.text,
          languageCode: transcript.languageCode,
          error: null,
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
        },
      });
      const stored = await this.findStored(engineKey, sampleId);
      if (!stored) throw error;
      return stored;
    }
  }

  /** A failure never replaces a success: only a missing or failed row is written. */
  private async storeFailure(engineKey: string, sampleId: string, modelId: string, error: string) {
    try {
      await this.prisma.speechToTextResult.create({
        data: { engineKey, sampleId, modelId, status: SttCheckStatus.FAILED, error },
      });
    } catch (createError) {
      if (!(createError instanceof Prisma.PrismaClientKnownRequestError) || createError.code !== 'P2002') {
        throw createError;
      }
      await this.prisma.speechToTextResult.updateMany({
        where: { engineKey, sampleId, status: SttCheckStatus.FAILED },
        data: { error, modelId, attempts: { increment: 1 }, lastAttemptAt: new Date() },
      });
    }
    this.logger.warn(`Stored failed check ${engineKey} for sample ${sampleId}: ${error}`);
  }

  private async reviewState(modelId: string) {
    const [latest, failures] = await Promise.all([
      this.prisma.speechToTextResult.findMany({
        where: { modelId },
        orderBy: { lastAttemptAt: 'desc' },
        take: FAILURES_BEFORE_REVIEW,
        select: { status: true },
      }),
      this.prisma.speechToTextResult.findMany({
        where: { modelId, status: SttCheckStatus.FAILED },
        orderBy: { lastAttemptAt: 'desc' },
        take: RECENT_FAILURES,
        select: { sampleId: true, error: true, lastAttemptAt: true, sample: { select: { sentence: true } } },
      }),
    ]);
    return {
      needsReview:
        latest.length === FAILURES_BEFORE_REVIEW && latest.every((attempt) => attempt.status === SttCheckStatus.FAILED),
      recentFailures: failures.map((failure) => ({
        sampleId: failure.sampleId,
        sentence: failure.sample.sentence,
        error: failure.error ?? 'The check failed.',
        failedAt: failure.lastAttemptAt,
      })),
    };
  }

  /** The next samples an engine has not checked successfully: stored failures first, then unchecked, oldest first. */
  private async nextBatch(engineKey: string, count: number) {
    const failed = await this.prisma.speechToTextResult.findMany({
      where: { engineKey, status: SttCheckStatus.FAILED },
      orderBy: [{ sample: { createdAt: 'asc' } }, { sample: { id: 'asc' } }],
      take: count,
      select: { sampleId: true },
    });
    const unchecked =
      failed.length < count
        ? await this.prisma.datasetSample.findMany({
            where: { speechToTextResults: { none: { engineKey } } },
            orderBy: sampleOrder,
            take: count - failed.length,
            select: { id: true },
          })
        : [];
    return [...failed.map((result) => result.sampleId), ...unchecked.map((sample) => sample.id)];
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
    if (result.status === SttCheckStatus.FAILED) {
      return {
        modelId,
        sampleId: result.sampleId,
        status: result.status,
        error: result.error ?? 'The check failed.',
        failedAt: result.lastAttemptAt,
      };
    }
    const transcript = result.transcript ?? '';
    return {
      modelId,
      sampleId: result.sampleId,
      status: result.status,
      transcript,
      languageCode: result.languageCode,
      accuracy: scoreTranscript(sentence, transcript),
    };
  }
}
