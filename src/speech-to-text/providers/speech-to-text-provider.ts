import { SttProvider } from '@prisma/client';

export interface PublicModelConfig {
  modelId: string;
  languageCode: string | null;
  apiKeyHint: string;
  secureMode?: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface AudioInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface TranscriptionResult {
  text: string;
  languageCode: string | null;
}

export interface SpeechToTextProvider {
  readonly id: SttProvider;
  readonly supportsConnectionTest: boolean;
  validateCreate(config: unknown): Record<string, unknown>;
  validateUpdate(config: unknown, existing: Record<string, unknown>): Record<string, unknown>;
  toPublic(config: Record<string, unknown>): PublicModelConfig;
  /** Settings that decide the transcript. Never includes the API key, so checks survive key changes. */
  engineKey(config: Record<string, unknown>): string;
  test?(config: Record<string, unknown>): Promise<ConnectionTestResult>;
  transcribe(config: Record<string, unknown>, audio: AudioInput, signal?: AbortSignal): Promise<TranscriptionResult>;
}
