import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ExecutionAudioKind, ExecutionStatus, Prisma } from '@prisma/client';
import { inquirySystemPrompt, PromptTopic } from '../llm/inquiry-turn';
import { ModelPricingService } from '../model-pricing/model-pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { reusedSpeechPayload, speechClipKey } from '../text-to-speech/speech-clip';
import { CreateScenarioExecutionDto, ExecutionEventDto, FinishScenarioExecutionDto } from './dto/scenario-execution.dto';
import { ExecutionContext } from './execution-context';
import { highlightPrices, priceExecution, readPriceParts, speechGenerationUsd } from './execution-price';
import { speechSegments } from './speech-segments';

export const MAX_EXECUTION_AUDIO_BYTES = 30 * 1024 * 1024;
const STALE_MS = 2 * 60 * 1000;
const STALE_MESSAGE = 'The browser stopped reporting.';
const PEAKS = 240;
const MP3_BITRATE = 128_000;

const BROWSER_EVENTS = new Set([
  'microphone.opened',
  'microphone.denied',
  'node.entered',
  'node.left',
  'tts.played',
  'barge_in',
  'turn.counted',
  'inquiry.accepted',
  'switch.routed',
  'closing.routed',
  'execution.ended',
  'llm.aborted',
]);

const SECRET_KEY = /^(apiKey|api_key|authorization|password|secret|accessToken|refreshToken|xi-api-key)$/i;

const summarySelect = {
  id: true,
  scenarioId: true,
  status: true,
  startedAt: true,
  endedAt: true,
  durationMs: true,
  inquiry: true,
  topicId: true,
  topicLabel: true,
  errorMessage: true,
  priceUsd: true,
  priceComplete: true,
  priceParts: true,
  startedBy: { select: { email: true } },
  audio: { where: { kind: ExecutionAudioKind.MIX }, select: { id: true } },
} satisfies Prisma.ScenarioExecutionSelect;

type SummaryRow = Prisma.ScenarioExecutionGetPayload<{ select: typeof summarySelect }>;

export interface ModelSnapshot {
  modelId: string;
  modelName: string;
  provider: string;
  providerModel: string;
}

export interface SpeechSnapshot extends ModelSnapshot {
  voiceId: string;
  voiceName: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface UploadFile {
  buffer?: Buffer;
  size?: number;
  mimetype?: string;
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || SECRET_KEY.test(key)) continue;
    out[key] = scrub(item);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function blankToNull(value?: string | null) {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

function topicsOf(value: unknown): PromptTopic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const topics: PromptTopic[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined;
    const row = item as { id?: unknown; description?: unknown };
    if (typeof row.id !== 'string' || typeof row.description !== 'string') return undefined;
    topics.push({ id: row.id, description: row.description });
  }
  return topics;
}

function annotateMessages(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { role?: unknown; content?: unknown; interrupted?: unknown };
    if (typeof row.role !== 'string' || typeof row.content !== 'string') return [];
    return [
      {
        role: row.role,
        content:
          row.interrupted === true
            ? `${row.content}\n[interrupted: the caller spoke over this and may not have heard it fully]`
            : row.content,
      },
    ];
  });
}

function encodeCursor(startedAt: Date, id: string) {
  return Buffer.from(`${startedAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string) {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const split = raw.lastIndexOf('|');
    if (split <= 0) return null;
    const startedAt = new Date(raw.slice(0, split));
    const id = raw.slice(split + 1);
    if (Number.isNaN(startedAt.getTime()) || !id) return null;
    return { startedAt, id };
  } catch {
    return null;
  }
}

function mp3DurationMs(byteSize: number) {
  return Math.round((byteSize * 8 * 1000) / MP3_BITRATE);
}

@Injectable()
export class ScenarioExecutionsService implements OnModuleInit {
  private readonly logger = new Logger(ScenarioExecutionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: ModelPricingService,
  ) {}

  async onModuleInit() {
    try {
      await this.settleReusedSpeech();
      await this.priceStored();
    } catch (error) {
      this.logger.warn(`Could not price existing executions: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  async create(dto: CreateScenarioExecutionDto, userId: string) {
    if (!Array.isArray(dto.graph.nodes) || !Array.isArray(dto.graph.edges)) {
      throw new BadRequestException('The scenario graph is incomplete.');
    }
    const scenario = await this.prisma.scenario.findUnique({ where: { id: dto.scenarioId }, select: { id: true } });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    try {
      const row = await this.prisma.scenarioExecution.create({
        data: {
          id: dto.id,
          scenarioId: dto.scenarioId,
          startedById: userId,
          graph: dto.graph as Prisma.InputJsonValue,
        },
        select: summarySelect,
      });
      return this.present(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.scenarioExecution.findUnique({ where: { id: dto.id }, select: summarySelect });
        if (existing?.scenarioId === dto.scenarioId) return this.present(existing);
        throw new ConflictException('This execution id is already in use.');
      }
      throw error;
    }
  }

  async addEvents(id: string, events: ExecutionEventDto[]) {
    await this.findOrThrow(id);
    if (events.some((event) => !BROWSER_EVENTS.has(event.type))) {
      throw new BadRequestException('Unknown event type.');
    }
    const stored = [];
    for (const event of events) {
      const payload = (event.type === 'llm.aborted' ? this.enrichAbort(event.payload) : scrub(event.payload)) as Prisma.InputJsonValue;
      const row = await this.prisma.scenarioExecutionEvent.upsert({
        where: { executionId_clientSeq: { executionId: id, clientSeq: event.clientSeq } },
        create: {
          executionId: id,
          clientSeq: event.clientSeq,
          offsetMs: event.offsetMs,
          type: event.type,
          nodeId: event.nodeId ?? null,
          payload,
        },
        update: {
          offsetMs: event.offsetMs,
          type: event.type,
          nodeId: event.nodeId ?? null,
          payload,
        },
      });
      stored.push(this.presentEvent(row, id));
    }
    await this.touch(id);
    return stored;
  }

  async heartbeat(id: string) {
    const updated = await this.prisma.scenarioExecution.updateMany({
      where: { id, status: ExecutionStatus.RUNNING },
      data: { lastActivityAt: new Date() },
    });
    if (updated.count === 0) await this.findOrThrow(id);
    return { ok: true };
  }

  async finish(id: string, dto: FinishScenarioExecutionDto) {
    const existing = await this.findOrThrow(id);
    if (existing.status !== ExecutionStatus.RUNNING) return this.present(existing);
    await this.prisma.scenarioExecution.updateMany({
      where: { id, status: ExecutionStatus.RUNNING },
      data: {
        status: dto.status,
        durationMs: dto.durationMs,
        inquiry: blankToNull(dto.inquiry),
        topicId: blankToNull(dto.topicId),
        topicLabel: blankToNull(dto.topicLabel),
        errorMessage: blankToNull(dto.errorMessage),
        endedAt: new Date(),
        lastActivityAt: new Date(),
      },
    });
    await this.priceStored([id]);
    return this.present(await this.findOrThrow(id));
  }

  async saveAudio(id: string, files: { caller?: UploadFile[]; mix?: UploadFile[] }, peaksRaw?: string) {
    await this.findOrThrow(id);
    const caller = files.caller?.[0];
    const mix = files.mix?.[0];
    let callerStored = false;
    let mixStored = false;
    let rejected = false;
    if (caller?.buffer?.length) {
      if (this.rejectedFile(caller)) rejected = true;
      else {
        await this.upsertTrack(id, ExecutionAudioKind.CALLER, caller);
        callerStored = true;
      }
    }
    if (mix?.buffer?.length) {
      if (this.rejectedFile(mix)) rejected = true;
      else {
        await this.upsertTrack(id, ExecutionAudioKind.MIX, mix);
        mixStored = true;
      }
    }
    const peaks = this.readPeaks(peaksRaw);
    await this.prisma.scenarioExecution.update({
      where: { id },
      data: {
        ...(peaks ? { peaks } : {}),
        ...(callerStored ? { callerMime: caller?.mimetype || 'application/octet-stream' } : {}),
        ...(mixStored ? { mixMime: mix?.mimetype || 'application/octet-stream' } : {}),
        lastActivityAt: new Date(),
      },
    });
    return {
      ...this.present(await this.findOrThrow(id)),
      callerStored,
      mixStored,
      ...(rejected ? { message: 'The recording could not be stored.' } : {}),
    };
  }

  async list(scenarioId: string, query: { status?: string; limit?: string; cursor?: string }) {
    const scenario = await this.prisma.scenario.findUnique({ where: { id: scenarioId }, select: { id: true } });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    await this.settleStale(scenarioId);
    const status = this.readStatus(query.status);
    const limit = this.readLimit(query.limit);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) throw new BadRequestException('The cursor is not valid.');
    const rows = await this.prisma.scenarioExecution.findMany({
      where: {
        scenarioId,
        ...(status ? { status } : {}),
        ...(cursor
          ? {
              OR: [{ startedAt: { lt: cursor.startedAt } }, { startedAt: cursor.startedAt, id: { lt: cursor.id } }],
            }
          : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: summarySelect,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.present(row)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.startedAt, last.id) : null,
    };
  }

  async get(id: string) {
    await this.settleStale(undefined, id);
    const row = await this.prisma.scenarioExecution.findUnique({
      where: { id },
      include: {
        startedBy: { select: { email: true } },
        audio: { select: { id: true, kind: true } },
        events: { orderBy: [{ offsetMs: 'asc' }, { clientSeq: 'asc' }] },
      },
    });
    if (!row) throw new NotFoundException('Execution not found.');
    const events = row.events.map((event) => this.presentEvent(event, row.id));
    const segments = speechSegments(row.events.map((event) => ({ id: event.id, type: event.type, offsetMs: event.offsetMs, payload: event.payload })));
    const prices = highlightPrices(segments, row.events, readPriceParts(row.priceParts));
    return {
      ...this.present({ ...row, audio: row.audio.filter((item) => item.kind === ExecutionAudioKind.MIX) }),
      topicId: row.topicId,
      graph: row.graph,
      peaks: this.presentPeaks(row.peaks),
      segments: segments.map((segment) => ({ ...segment, prices: prices[segment.eventId] ?? [] })),
      events,
    };
  }

  async mix(id: string) {
    const row = await this.prisma.scenarioExecutionAudio.findFirst({
      where: { executionId: id, kind: ExecutionAudioKind.MIX },
      select: { audio: true, mimeType: true },
    });
    if (!row) throw new NotFoundException('This execution has no recording.');
    return row;
  }

  async audioFile(executionId: string, audioId: string) {
    const row = await this.prisma.scenarioExecutionAudio.findFirst({
      where: { id: audioId, executionId },
      select: { audio: true, mimeType: true },
    });
    if (!row) throw new NotFoundException('Audio not found.');
    return row;
  }

  async recordTranscription(
    ctx: ExecutionContext | null,
    input: {
      model: ModelSnapshot;
      transcript: string;
      languageCode: string | null;
      latencyMs: number;
      audio: Buffer;
      mimeType: string;
      error?: string | null;
    },
  ) {
    if (!ctx) return;
    const failed = Boolean(input.error) || !input.transcript.trim();
    await this.recordProviderEvent(ctx, {
      type: failed ? 'stt.failed' : 'stt.completed',
      audio: { buffer: input.audio, mimeType: input.mimeType, kind: ExecutionAudioKind.UTTERANCE },
      payload: failed
        ? {
            ...input.model,
            error: input.error || 'The transcript was empty.',
            utteranceStartMs: ctx.utteranceStartedMs,
            utteranceDurationMs: ctx.utteranceDurationMs,
          }
        : {
            ...input.model,
            transcript: input.transcript,
            languageCode: input.languageCode,
            latencyMs: input.latencyMs,
            utteranceStartMs: ctx.utteranceStartedMs,
            utteranceDurationMs: ctx.utteranceDurationMs,
          },
    });
  }

  async recordSpeech(
    ctx: ExecutionContext | null,
    input: {
      model: SpeechSnapshot;
      text: string;
      latencyMs: number;
      audio?: Buffer;
      mimeType?: string;
      cached?: boolean;
      error?: string | null;
    },
  ) {
    if (!ctx) return;
    const kind = ctx.ttsKind ?? 'step';
    if (input.error || !input.audio?.length) {
      await this.recordProviderEvent(ctx, {
        type: 'tts.failed',
        payload: {
          ...input.model,
          text: input.text,
          kind,
          error: input.error || 'Speech was not generated.',
        },
      });
      return;
    }
    const mimeType = input.mimeType || 'audio/mpeg';
    const durationMs = /mpeg|mp3/i.test(mimeType) ? mp3DurationMs(input.audio.length) : null;
    await this.recordProviderEvent(ctx, {
      type: 'tts.ready',
      audio: { buffer: input.audio, mimeType, kind: ExecutionAudioKind.TTS },
      payload: {
        ...input.model,
        text: input.text,
        kind,
        cached: input.cached === true,
        latencyMs: input.latencyMs,
        durationMs,
      },
    });
  }

  async recordLlm(
    ctx: ExecutionContext | null,
    input: {
      model: ModelSnapshot;
      systemPrompt: string;
      messages: unknown;
      note?: string | null;
      topics?: unknown;
      defaultTopicId?: string | null;
      raw: unknown;
      turn?: unknown;
      latencyMs: number;
      usage: LlmUsage | null;
      error?: string | null;
    },
  ) {
    if (!ctx) return;
    const shared = {
      ...input.model,
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      note: input.note ?? null,
      topics: input.topics ?? null,
      defaultTopicId: input.defaultTopicId ?? null,
    };
    if (input.error) {
      await this.recordProviderEvent(ctx, {
        type: 'llm.failed',
        payload: {
          ...shared,
          error: input.error,
          ...(input.raw != null ? { raw: input.raw } : {}),
        },
      });
      return;
    }
    await this.recordProviderEvent(ctx, {
      type: 'llm.completed',
      payload: {
        ...shared,
        raw: input.raw,
        turn: input.turn,
        latencyMs: input.latencyMs,
        ...(input.usage ? { usage: input.usage } : {}),
      },
    });
  }

  private async recordProviderEvent(
    ctx: ExecutionContext,
    input: {
      type: string;
      payload: Record<string, unknown>;
      audio?: { buffer: Buffer; mimeType: string; kind: ExecutionAudioKind };
    },
  ) {
    try {
      const execution = await this.prisma.scenarioExecution.findUnique({
        where: { id: ctx.executionId },
        select: { status: true },
      });
      if (!execution || execution.status !== ExecutionStatus.RUNNING) return;
      let audioId: string | null = null;
      if (input.audio && input.audio.buffer.length > 0 && input.audio.buffer.length <= MAX_EXECUTION_AUDIO_BYTES) {
        audioId = await this.storeEventAudio(ctx, input.audio);
      }
      const payload = scrub({ ...input.payload, ...(audioId ? { audioId } : {}) }) as Prisma.InputJsonValue;
      await this.prisma.scenarioExecutionEvent.upsert({
        where: { executionId_clientSeq: { executionId: ctx.executionId, clientSeq: ctx.clientSeq } },
        create: {
          executionId: ctx.executionId,
          clientSeq: ctx.clientSeq,
          offsetMs: ctx.offsetMs,
          type: input.type,
          nodeId: ctx.nodeId,
          payload,
          audioId,
        },
        update: {
          offsetMs: ctx.offsetMs,
          type: input.type,
          nodeId: ctx.nodeId,
          payload,
          audioId,
        },
      });
      await this.touch(ctx.executionId);
    } catch (error) {
      this.logger.warn(`Could not record ${input.type} for execution ${ctx.executionId}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async storeEventAudio(ctx: ExecutionContext, audio: { buffer: Buffer; mimeType: string; kind: ExecutionAudioKind }) {
    const existing = await this.prisma.scenarioExecutionEvent.findUnique({
      where: { executionId_clientSeq: { executionId: ctx.executionId, clientSeq: ctx.clientSeq } },
      select: { audioId: true },
    });
    const data = {
      mimeType: audio.mimeType || 'application/octet-stream',
      audio: Uint8Array.from(audio.buffer),
      byteSize: audio.buffer.length,
    };
    if (existing?.audioId) {
      await this.prisma.scenarioExecutionAudio.update({ where: { id: existing.audioId }, data });
      return existing.audioId;
    }
    const created = await this.prisma.scenarioExecutionAudio.create({
      data: { executionId: ctx.executionId, kind: audio.kind, ...data },
      select: { id: true },
    });
    return created.id;
  }

  private async upsertTrack(executionId: string, kind: ExecutionAudioKind, file: UploadFile) {
    const data = {
      mimeType: file.mimetype || 'application/octet-stream',
      audio: Uint8Array.from(file.buffer ?? []),
      byteSize: file.buffer?.length ?? 0,
    };
    const existing = await this.prisma.scenarioExecutionAudio.findFirst({
      where: { executionId, kind },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.scenarioExecutionAudio.update({ where: { id: existing.id }, data });
      return;
    }
    await this.prisma.scenarioExecutionAudio.create({ data: { executionId, kind, ...data } });
  }

  private rejectedFile(file: UploadFile) {
    const size = file.size ?? file.buffer?.length ?? 0;
    if (size > MAX_EXECUTION_AUDIO_BYTES) return true;
    const mimeType = file.mimetype || 'application/octet-stream';
    return !/^(audio\/|video\/|application\/octet-stream)/.test(mimeType);
  }

  private readPeaks(raw?: string): Prisma.InputJsonValue | undefined {
    if (!raw?.trim()) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== PEAKS) return undefined;
      if (!parsed.every((item) => typeof item === 'number' && Number.isFinite(item))) return undefined;
      return parsed.map((item) => Math.max(0, Math.min(1, item)));
    } catch {
      return undefined;
    }
  }

  private presentPeaks(value: Prisma.JsonValue) {
    if (!Array.isArray(value) || value.length !== PEAKS) return null;
    if (!value.every((item) => typeof item === 'number' && Number.isFinite(item))) return null;
    return value;
  }

  private readStatus(status?: string) {
    if (!status) return undefined;
    if (status === ExecutionStatus.RUNNING || status === ExecutionStatus.FINISHED || status === ExecutionStatus.STOPPED || status === ExecutionStatus.FAILED) {
      return status;
    }
    throw new BadRequestException('Unknown execution status.');
  }

  private readLimit(limit?: string) {
    if (!limit) return 30;
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) throw new BadRequestException('Limit must be between 1 and 100.');
    return Math.min(100, parsed);
  }

  private async settleStale(scenarioId?: string, id?: string) {
    const cutoff = new Date(Date.now() - STALE_MS);
    const stale = await this.prisma.scenarioExecution.findMany({
      where: {
        status: ExecutionStatus.RUNNING,
        lastActivityAt: { lt: cutoff },
        ...(scenarioId ? { scenarioId } : {}),
        ...(id ? { id } : {}),
      },
      select: { id: true, startedAt: true, lastActivityAt: true },
    });
    await Promise.all(
      stale.map((row) =>
        this.prisma.scenarioExecution.updateMany({
          where: { id: row.id, status: ExecutionStatus.RUNNING },
          data: {
            status: ExecutionStatus.FAILED,
            errorMessage: STALE_MESSAGE,
            endedAt: row.lastActivityAt,
            durationMs: Math.max(0, row.lastActivityAt.getTime() - row.startedAt.getTime()),
          },
        }),
      ),
    );
    if (stale.length > 0) await this.priceStored(stale.map((row) => row.id));
  }

  private async settleReusedSpeech() {
    const clips = await this.prisma.textToSpeechClip.findMany({
      select: {
        id: true,
        cacheKey: true,
        createdAt: true,
        text: true,
        providerModelId: true,
        priceUsd: true,
        model: { select: { provider: true } },
      },
    });
    const clipByKey = new Map(clips.map((clip) => [clip.cacheKey, clip]));
    const ready = await this.prisma.scenarioExecutionEvent.findMany({
      where: { type: 'tts.ready' },
      select: { id: true, executionId: true, createdAt: true, payload: true },
    });
    const patches = new Map<string, { executionId: string; payload: Prisma.InputJsonValue }>();
    for (const event of ready) {
      const payload = asRecord(event.payload);
      const modelId = typeof payload.modelId === 'string' ? payload.modelId : '';
      const providerModelId = typeof payload.providerModel === 'string' ? payload.providerModel : '';
      const voiceId = typeof payload.voiceId === 'string' ? payload.voiceId : '';
      const spoken = typeof payload.text === 'string' ? payload.text : '';
      if (!modelId || !providerModelId || !voiceId || !spoken) continue;
      const clip = clipByKey.get(speechClipKey({ modelId, providerModelId, voiceId, text: spoken }));
      const next = reusedSpeechPayload(payload, event.createdAt, clip?.createdAt);
      if (!next) continue;
      patches.set(event.id, { executionId: event.executionId, payload: next as Prisma.InputJsonValue });
    }
    const unpriced = clips.filter((clip) => clip.priceUsd == null);
    if (patches.size === 0 && unpriced.length === 0) return;

    const catalog = await this.pricing.rates();
    let pricedClips = 0;
    for (const clip of unpriced) {
      const usd = speechGenerationUsd(clip.model.provider, clip.providerModelId, clip.text, catalog);
      if (usd == null) continue;
      const updated = await this.prisma.textToSpeechClip.updateMany({
        where: { id: clip.id, priceUsd: null },
        data: { priceUsd: usd.toFixed(6) },
      });
      pricedClips += updated.count;
    }
    if (pricedClips > 0) this.logger.log(`Stored the first cost of ${pricedClips} cached speech line${pricedClips === 1 ? '' : 's'}.`);
    if (patches.size === 0) return;

    const executionIds = [...new Set([...patches.values()].map((patch) => patch.executionId))];
    const rows = await this.prisma.scenarioExecution.findMany({
      where: { id: { in: executionIds }, status: { not: ExecutionStatus.RUNNING } },
      select: { id: true, events: { select: { id: true, type: true, payload: true } } },
    });
    const finished = new Set(rows.map((row) => row.id));
    let stored = 0;
    let freed = 0;
    for (const row of rows) {
      const changed = row.events.filter((event) => patches.has(event.id));
      if (changed.length === 0) continue;
      const quote = priceExecution(
        row.events.map((event) => {
          const patch = patches.get(event.id);
          return patch ? { id: event.id, type: event.type, payload: patch.payload } : event;
        }),
        catalog,
      );
      if (!quote.persist) continue;
      await this.prisma.$transaction([
        ...changed.map((event) =>
          this.prisma.scenarioExecutionEvent.update({
            where: { id: event.id },
            data: { payload: patches.get(event.id)?.payload },
          }),
        ),
        this.prisma.scenarioExecution.updateMany({
          where: { id: row.id, status: { not: ExecutionStatus.RUNNING } },
          data: {
            priceUsd: quote.usd.toFixed(6),
            priceComplete: quote.complete,
            priceParts: quote.parts as unknown as Prisma.InputJsonValue,
          },
        }),
      ]);
      stored += 1;
      freed += changed.length;
    }
    const running = [...patches.entries()].filter(([, patch]) => !finished.has(patch.executionId));
    if (running.length > 0) {
      await this.prisma.$transaction(
        running.map(([id, patch]) =>
          this.prisma.scenarioExecutionEvent.update({
            where: { id },
            data: { payload: patch.payload },
          }),
        ),
      );
    }
    if (freed > 0) this.logger.log(`Counted ${freed} reused speech line${freed === 1 ? '' : 's'} as free across ${stored} execution${stored === 1 ? '' : 's'}.`);
  }

  private async priceStored(ids?: string[]) {
    if (ids && ids.length === 0) return;
    const rows = await this.prisma.scenarioExecution.findMany({
      where: {
        status: { not: ExecutionStatus.RUNNING },
        ...(ids ? { id: { in: ids } } : {}),
        OR: [{ priceUsd: null }, { priceParts: { equals: Prisma.DbNull } }],
      },
      select: { id: true, priceUsd: true, events: { select: { id: true, type: true, payload: true } } },
    });
    if (rows.length === 0) return;
    const catalog = await this.pricing.rates();
    let stored = 0;
    for (const row of rows) {
      const quote = priceExecution(row.events, catalog);
      if (!quote.persist) continue;
      const updated = await this.prisma.scenarioExecution.updateMany({
        where: { id: row.id, OR: [{ priceUsd: null }, { priceParts: { equals: Prisma.DbNull } }] },
        data: {
          ...(row.priceUsd == null ? { priceUsd: quote.usd.toFixed(6), priceComplete: quote.complete } : {}),
          priceParts: quote.parts as unknown as Prisma.InputJsonValue,
        },
      });
      stored += updated.count;
    }
    if (stored > 0) this.logger.log(`Stored the price of ${stored} execution${stored === 1 ? '' : 's'}.`);
  }

  private async findOrThrow(id: string) {
    const row = await this.prisma.scenarioExecution.findUnique({ where: { id }, select: summarySelect });
    if (!row) throw new NotFoundException('Execution not found.');
    return row;
  }

  private touch(id: string) {
    return this.prisma.scenarioExecution.updateMany({
      where: { id },
      data: { lastActivityAt: new Date() },
    });
  }

  private enrichAbort(payload: Record<string, unknown>) {
    const clean = asRecord(scrub(payload));
    const note = typeof clean.note === 'string' ? clean.note : undefined;
    const topics = topicsOf(clean.topics);
    const defaultTopicId = typeof clean.defaultTopicId === 'string' ? clean.defaultTopicId : undefined;
    return {
      ...clean,
      systemPrompt: inquirySystemPrompt(note, topics, defaultTopicId),
      messages: annotateMessages(clean.messages),
    };
  }

  private present(row: SummaryRow) {
    return {
      id: row.id,
      scenarioId: row.scenarioId,
      status: row.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: row.durationMs,
      inquiry: row.inquiry,
      topicLabel: row.topicLabel,
      errorMessage: row.errorMessage,
      priceUsd: row.priceUsd == null ? null : Number(row.priceUsd.toString()),
      priceComplete: row.priceComplete,
      priceParts: totalsOf(row.priceParts),
      startedBy: { email: row.startedBy.email },
      hasMix: row.audio.length > 0,
    };
  }

  private presentEvent(
    event: { id: string; clientSeq: number; offsetMs: number; type: string; nodeId: string | null; payload: Prisma.JsonValue; audioId: string | null; createdAt: Date },
    executionId: string,
  ) {
    const payload = asRecord(event.payload);
    return {
      id: event.id,
      clientSeq: event.clientSeq,
      offsetMs: event.offsetMs,
      type: event.type,
      nodeId: event.nodeId,
      createdAt: event.createdAt,
      payload: event.audioId
        ? { ...payload, audioId: event.audioId, audioUrl: `/scenario-executions/${executionId}/audio/${event.audioId}` }
        : payload,
    };
  }
}

function totalsOf(value: Prisma.JsonValue) {
  const parts = readPriceParts(value);
  if (!parts) return null;
  return { speechToText: parts.speechToText, textToSpeech: parts.textToSpeech, model: parts.model };
}
