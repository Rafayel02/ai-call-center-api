export interface CallerClipSource {
  id: string;
  executionId: string;
  audioId: string | null;
  payload: unknown;
  startedAt: Date;
}

export interface CallerClip {
  id: string;
  executionId: string;
  startedAt: string;
  text: string;
  audioUrl: string;
}

function record(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

/** Caller lines that were stored with both audio and a transcript. Empty transcripts are left out. */
export function callerClips(events: CallerClipSource[]): CallerClip[] {
  const items: CallerClip[] = [];
  for (const event of events) {
    if (!event.audioId) continue;
    const transcript = record(event.payload)?.transcript;
    const text = typeof transcript === 'string' ? transcript.trim() : '';
    if (!text) continue;
    items.push({
      id: event.id,
      executionId: event.executionId,
      startedAt: event.startedAt.toISOString(),
      text: text.slice(0, 1000),
      audioUrl: `/scenario-executions/${event.executionId}/audio/${event.audioId}`,
    });
  }
  return items;
}
