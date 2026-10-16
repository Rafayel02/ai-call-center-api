import { createHash } from 'node:crypto';

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
