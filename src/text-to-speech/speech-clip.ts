import { createHash } from 'node:crypto';

export function speechClipKey(input: {
  modelId: string;
  providerModelId: string;
  voiceId: string;
  text: string;
  format?: string;
}) {
  // MP3 clips keep the key they had before formats existed, so clips already paid for are still found.
  const parts = [input.modelId, input.providerModelId, input.voiceId, input.text];
  if (input.format && input.format !== 'mp3_44100_128') parts.push(input.format);
  return createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
}
