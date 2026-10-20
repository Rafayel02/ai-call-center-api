export const SPOKEN_KINDS = ['step', 'reply', 'delay', 'menu', 'sorry'] as const;

export type SpokenKind = (typeof SPOKEN_KINDS)[number];

export function isSpokenKind(value: unknown): value is SpokenKind {
  return typeof value === 'string' && (SPOKEN_KINDS as readonly string[]).includes(value);
}

/** Where a provider call belongs in an execution. The call session builds one for each provider call it makes. */
export interface ExecutionContext {
  executionId: string;
  clientSeq: number;
  offsetMs: number;
  nodeId: string | null;
  utteranceStartedMs: number | null;
  utteranceDurationMs: number | null;
  ttsKind: SpokenKind | null;
}
