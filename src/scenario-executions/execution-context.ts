import { IncomingHttpHeaders } from 'http';

export const SPOKEN_KINDS = ['step', 'reply', 'delay', 'menu', 'sorry'] as const;

export type SpokenKind = (typeof SPOKEN_KINDS)[number];

export function isSpokenKind(value: unknown): value is SpokenKind {
  return typeof value === 'string' && (SPOKEN_KINDS as readonly string[]).includes(value);
}

export interface ExecutionContext {
  executionId: string;
  clientSeq: number;
  offsetMs: number;
  nodeId: string | null;
  utteranceStartedMs: number | null;
  utteranceDurationMs: number | null;
  ttsKind: SpokenKind | null;
}

function one(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function integer(value: string) {
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readExecutionContext(headers: IncomingHttpHeaders): ExecutionContext | null {
  const executionId = one(headers['x-execution-id']).trim();
  if (!executionId) return null;
  if (!UUID.test(executionId)) return null;
  const clientSeq = integer(one(headers['x-execution-seq']).trim());
  if (clientSeq == null || clientSeq < 0) return null;
  const offset = integer(one(headers['x-execution-offset-ms']).trim());
  const nodeId = one(headers['x-execution-node-id']).trim();
  const utteranceStarted = integer(one(headers['x-utterance-started-ms']).trim());
  const utteranceDuration = integer(one(headers['x-utterance-duration-ms']).trim());
  const kind = one(headers['x-execution-tts-kind']).trim();
  return {
    executionId,
    clientSeq,
    offsetMs: offset != null && offset >= 0 ? offset : 0,
    nodeId: nodeId ? nodeId.slice(0, 80) : null,
    utteranceStartedMs: utteranceStarted != null && utteranceStarted >= 0 ? utteranceStarted : null,
    utteranceDurationMs: utteranceDuration != null && utteranceDuration >= 0 ? utteranceDuration : null,
    ttsKind: isSpokenKind(kind) ? kind : null,
  };
}
