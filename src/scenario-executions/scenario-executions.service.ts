import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CallbackReason, CallEndReason, ExecutionAudioKind, ExecutionChannel, ExecutionStatus, Prisma } from '@prisma/client';
import { ulawToWav, wavDurationMs } from '../common/audio/wav';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionContext } from './execution-context';
import { speechSegments } from './speech-segments';

export const MAX_EXECUTION_AUDIO_BYTES = 30 * 1024 * 1024;
const STALE_MS = 2 * 60 * 1000;
export const STALE_MESSAGE = 'The call stopped reporting.';
const PEAKS = 240;
const MP3_BITRATE = 128_000;

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
  channel: true,
  menuChoice: true,
  startedBy: { select: { email: true } },
  audio: { where: { kind: ExecutionAudioKind.MIX }, select: { id: true } },
  call: {
    select: {
      fromNumber: true,
      toNumber: true,
      endReason: true,
      callbackReason: true,
      calledBackAt: true,
      calledBackBy: { select: { email: true } },
    },
  },
} satisfies Prisma.ScenarioExecutionSelect;

/** One event the call session writes. The session numbers them itself. */
export interface SessionEvent {
  seq: number;
  offsetMs: number;
  type: string;
  nodeId: string | null;
  payload: Record<string, unknown>;
}

export interface SessionEnding {
  status: 'FINISHED' | 'STOPPED' | 'FAILED';
  durationMs: number;
  inquiry: string | null;
  topicId: string | null;
  topicLabel: string | null;
  menuChoice: string | null;
  errorMessage: string | null;
}

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

export function encodeCursor(startedAt: Date, id: string) {
  return Buffer.from(`${startedAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string) {
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
export class ScenarioExecutionsService {
  private readonly logger = new Logger(ScenarioExecutionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Creates the execution for a call the session runs. The API chooses the id. */
  async startSession(input: { scenarioId: string; graph: unknown; channel: ExecutionChannel; startedById: string | null }) {
    const row = await this.prisma.scenarioExecution.create({
      data: {
        id: crypto.randomUUID(),
        scenarioId: input.scenarioId,
        startedById: input.startedById,
        channel: input.channel,
        graph: input.graph as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Writes events from the session. A repeated sequence number replaces that event, so a retry never duplicates one. */
  async writeSessionEvents(id: string, events: SessionEvent[]) {
    for (const event of events) {
      const payload = scrub(event.payload) as Prisma.InputJsonValue;
      await this.prisma.scenarioExecutionEvent.upsert({
        where: { executionId_clientSeq: { executionId: id, clientSeq: event.seq } },
        create: { executionId: id, clientSeq: event.seq, offsetMs: event.offsetMs, type: event.type, nodeId: event.nodeId, payload },
        update: { offsetMs: event.offsetMs, type: event.type, nodeId: event.nodeId, payload },
      });
    }
    await this.touch(id);
  }

  heartbeatSession(id: string) {
    return this.touch(id);
  }

  /** Stores the caller track and the mix that the session built, both WAV. Returns false when either was too large. */
  async storeRecordings(id: string, input: { caller: Buffer; mix: Buffer; peaks: number[] }) {
    let stored = true;
    for (const [kind, audio] of [
      [ExecutionAudioKind.CALLER, input.caller],
      [ExecutionAudioKind.MIX, input.mix],
    ] as const) {
      if (audio.length > MAX_EXECUTION_AUDIO_BYTES) {
        stored = false;
        continue;
      }
      await this.upsertTrack(id, kind, { buffer: audio, mimetype: 'audio/wav' });
    }
    const peaks = this.readPeaks(JSON.stringify(input.peaks));
    await this.prisma.scenarioExecution.update({
      where: { id },
      data: {
        ...(peaks ? { peaks } : {}),
        ...(input.caller.length <= MAX_EXECUTION_AUDIO_BYTES ? { callerMime: 'audio/wav' } : {}),
        ...(input.mix.length <= MAX_EXECUTION_AUDIO_BYTES ? { mixMime: 'audio/wav' } : {}),
        lastActivityAt: new Date(),
      },
    });
    return stored;
  }

  /** Closes an execution the session ran. A second close is ignored. */
  async closeSession(id: string, ending: SessionEnding) {
    await this.prisma.scenarioExecution.updateMany({
      where: { id, status: ExecutionStatus.RUNNING },
      data: {
        status: ending.status,
        durationMs: ending.durationMs,
        inquiry: blankToNull(ending.inquiry),
        topicId: blankToNull(ending.topicId),
        topicLabel: blankToNull(ending.topicLabel),
        menuChoice: blankToNull(ending.menuChoice),
        errorMessage: blankToNull(ending.errorMessage),
        endedAt: new Date(),
        lastActivityAt: new Date(),
      },
    });
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
        call: summarySelect.call,
      },
    });
    if (!row) throw new NotFoundException('Execution not found.');
    const events = row.events.map((event) => this.presentEvent(event, row.id));
    return {
      ...this.present({ ...row, audio: row.audio.filter((item) => item.kind === ExecutionAudioKind.MIX) }),
      topicId: row.topicId,
      graph: row.graph,
      peaks: this.presentPeaks(row.peaks),
      segments: speechSegments(row.events.map((event) => ({ id: event.id, type: event.type, offsetMs: event.offsetMs, payload: event.payload }))),
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
    // Browsers cannot play raw μ-law, so a phone clip is stored as WAV for the debug view.
    const phone = /x-mulaw/i.test(input.mimeType ?? '');
    const audio = phone ? ulawToWav(input.audio) : input.audio;
    const mimeType = phone ? 'audio/wav' : input.mimeType || 'audio/mpeg';
    const durationMs = /mpeg|mp3/i.test(mimeType) ? mp3DurationMs(audio.length) : /wav/i.test(mimeType) ? wavDurationMs(audio) : null;
    await this.recordProviderEvent(ctx, {
      type: 'tts.ready',
      audio: { buffer: audio, mimeType, kind: ExecutionAudioKind.TTS },
      payload: {
        ...input.model,
        text: input.text,
        kind,
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

  /**
   * Marks a running execution `FAILED` once nothing has reported for 2 minutes. A phone call's row is closed with it,
   * marked for callback, because the caller was cut off.
   */
  async settleStale(scenarioId?: string, id?: string) {
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
    if (stale.length === 0) return;
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
    const executionId = { in: stale.map((row) => row.id) };
    await this.prisma.call.updateMany({ where: { executionId, endReason: null, callbackReason: null }, data: { callbackReason: CallbackReason.ERROR } });
    await this.prisma.call.updateMany({
      where: { executionId, endReason: null },
      data: { endReason: CallEndReason.ERROR, error: STALE_MESSAGE, endedAt: new Date() },
    });
  }

  private touch(id: string) {
    return this.prisma.scenarioExecution.updateMany({
      where: { id },
      data: { lastActivityAt: new Date() },
    });
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
      channel: row.channel,
      menuChoice: row.menuChoice,
      startedBy: row.startedBy ? { email: row.startedBy.email } : null,
      hasMix: row.audio.length > 0,
      call: row.call
        ? {
            fromNumber: row.call.fromNumber,
            toNumber: row.call.toNumber,
            endReason: row.call.endReason,
            callbackReason: row.call.callbackReason,
            calledBackAt: row.call.calledBackAt,
            calledBackBy: row.call.calledBackBy ? { email: row.call.calledBackBy.email } : null,
          }
        : null,
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
