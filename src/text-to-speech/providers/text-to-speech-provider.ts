import { TtsProvider } from '@prisma/client';

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface TtsVoice {
  id: string;
  name: string;
}

/** `mp3_44100_128` is what the browser plays. `ulaw_8000` is raw 8 kHz μ-law, the format of a phone call. */
export type SpeechFormat = 'mp3_44100_128' | 'ulaw_8000';

export const SPEECH_FORMAT_MIME: Record<SpeechFormat, string> = {
  mp3_44100_128: 'audio/mpeg',
  ulaw_8000: 'audio/x-mulaw',
};

export interface TextToSpeechProvider {
  readonly id: TtsProvider;
  readonly supportsConnectionTest: boolean;
  validateCreate(config: unknown): Promise<Record<string, unknown>>;
  validateUpdate(config: unknown, existing: Record<string, unknown>): Promise<Record<string, unknown>>;
  toPublic(config: Record<string, unknown>): Record<string, unknown>;
  test?(config: Record<string, unknown>): Promise<ConnectionTestResult>;
  testDraft?(config: unknown): Promise<ConnectionTestResult>;
  listVoices(config: unknown): Promise<TtsVoice[]>;
  listStoredVoices(config: Record<string, unknown>): Promise<TtsVoice[]>;
  speak(config: Record<string, unknown>, text: string, format: SpeechFormat, signal?: AbortSignal): Promise<Buffer>;
}
