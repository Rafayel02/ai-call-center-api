const SPOKEN_KEYS = ['reply', 'text', 'message', 'answer', 'response'] as const;

/** The chat call is required to return JSON. The phone should hear only the sentence. */
export function readSpokenReply(raw: string) {
  const trimmed = raw.trim();
  const parsed = parseObject(trimmed);
  if (parsed) {
    for (const key of SPOKEN_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
  throw new Error('The model did not return a spoken reply.');
}

function parseObject(raw: string): Record<string, unknown> | null {
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const value = JSON.parse(fenced) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}
