import { isSpokenKind, SpokenKind } from './execution-context';

export interface SegmentSource {
  id: string;
  type: string;
  offsetMs: number;
  payload: unknown;
}

export interface SpeechSegment {
  eventId: string;
  speaker: 'caller' | 'agent';
  kind: SpokenKind | null;
  text: string;
  startMs: number;
  endMs: number;
  interrupted: boolean;
}

function record(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

function text(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function finite(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function kindOf(value: unknown): SpeechSegment['kind'] {
  return isSpokenKind(value) ? value : null;
}

export function speechSegments(events: SegmentSource[]): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  for (const event of events) {
    const payload = record(event.payload);
    if (!payload) continue;
    if (event.type === 'tts.played') {
      const line = text(payload, 'text');
      if (line == null) continue;
      const endMs = finite(payload, 'endMs') ?? event.offsetMs;
      segments.push({
        eventId: event.id,
        speaker: 'agent',
        kind: kindOf(payload.kind),
        text: line,
        startMs: event.offsetMs,
        endMs,
        interrupted: payload.interrupted === true,
      });
      continue;
    }
    if (event.type === 'stt.completed') {
      const transcript = text(payload, 'transcript')?.trim() ?? '';
      if (!transcript) continue;
      const startMs = finite(payload, 'utteranceStartMs') ?? event.offsetMs;
      const durationMs = finite(payload, 'utteranceDurationMs');
      segments.push({
        eventId: event.id,
        speaker: 'caller',
        kind: null,
        text: transcript,
        startMs,
        endMs: startMs + (durationMs != null && durationMs > 0 ? durationMs : 0),
        interrupted: false,
      });
    }
  }
  return segments.sort((left, right) => left.startMs - right.startMs);
}
