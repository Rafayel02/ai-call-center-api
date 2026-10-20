import { createHash } from 'node:crypto';

const REUSE_AFTER_MS = 10_000;

export function speechWasReused(eventAt: Date, clipAt: Date) {
  return eventAt.getTime() - clipAt.getTime() > REUSE_AFTER_MS;
}

export function reusedSpeechPayload(payload: Record<string, unknown>, eventAt: Date, clipAt: Date | undefined) {
  if (payload.cached === true || !clipAt || !speechWasReused(eventAt, clipAt)) return null;
  return { ...payload, cached: true };
}

export function speechClipKey(input: {
  modelId: string;
  providerModelId: string;
  voiceId: string;
  text: string;
}) {
  return createHash('sha256')
    .update([input.modelId, input.providerModelId, input.voiceId, input.text].join('\0'), 'utf8')
    .digest('hex');
}
