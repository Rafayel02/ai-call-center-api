import { TtsProvider } from '@prisma/client';

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface TtsVoice {
  id: string;
  name: string;
}

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
  speak(config: Record<string, unknown>, text: string, format?: string): Promise<Buffer>;
  speakStream?(config: Record<string, unknown>, text: string, format: string, onChunk: (chunk: Buffer) => void): Promise<Buffer>;
}
