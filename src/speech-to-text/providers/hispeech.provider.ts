import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SttProvider } from '@prisma/client';
import { z } from 'zod';
import {
  decryptSecret,
  encryptSecret,
  encryptionKeyFromEnv,
  EncryptedSecret,
  secretHint,
} from '../../common/crypto/credential-cipher';
import { AudioInput, SpeechToTextProvider, TranscriptionResult } from './speech-to-text-provider';

const MODELS = ['model-23012026', 'model-01052025'] as const;

const createSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(8)
    .max(300)
    .refine((value) => !/[\r\n\u0000]/.test(value), 'API key contains invalid characters.'),
  modelId: z.enum(MODELS).default('model-23012026'),
  secureMode: z.boolean().optional().default(true),
});

const updateSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(8)
    .max(300)
    .refine((value) => !/[\r\n\u0000]/.test(value), 'API key contains invalid characters.')
    .optional(),
  modelId: z.enum(MODELS).optional(),
  secureMode: z.boolean().optional(),
});

interface StoredHiSpeechConfig {
  modelId: (typeof MODELS)[number];
  secureMode: boolean;
  apiKeyHint: string;
  apiKey: EncryptedSecret;
}

@Injectable()
export class HiSpeechProvider implements SpeechToTextProvider {
  readonly id = SttProvider.HISPEECH;
  readonly supportsConnectionTest = false;

  constructor(private readonly configService: ConfigService) {}

  validateCreate(config: unknown): Record<string, unknown> {
    const parsed = createSchema.safeParse(config ?? {});
    if (!parsed.success) {
      throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    }
    return this.store(parsed.data.apiKey, parsed.data.modelId, parsed.data.secureMode) as unknown as Record<
      string,
      unknown
    >;
  }

  validateUpdate(config: unknown, existing: Record<string, unknown>): Record<string, unknown> {
    const current = this.readStored(existing);
    const parsed = updateSchema.safeParse(config ?? {});
    if (!parsed.success) {
      throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    }
    const modelId = parsed.data.modelId ?? current.modelId;
    const secureMode = parsed.data.secureMode ?? current.secureMode;
    if (!parsed.data.apiKey) {
      return { ...current, modelId, secureMode } as unknown as Record<string, unknown>;
    }
    return this.store(parsed.data.apiKey, modelId, secureMode) as unknown as Record<string, unknown>;
  }

  toPublic(config: Record<string, unknown>) {
    const stored = this.readStored(config);
    return {
      modelId: stored.modelId,
      languageCode: null,
      apiKeyHint: stored.apiKeyHint,
      secureMode: stored.secureMode,
    };
  }

  engineKey(config: Record<string, unknown>) {
    const stored = this.readStored(config);
    return [this.id, stored.modelId, stored.secureMode ? 'secure' : 'standard'].join('|');
  }

  async transcribe(config: Record<string, unknown>, audio: AudioInput): Promise<TranscriptionResult> {
    if (audio.buffer.length < 1000) {
      throw new BadRequestException('That recording is too short.');
    }
    const stored = this.readStored(config);
    const apiKey = decryptSecret(stored.apiKey, this.key());
    const form = new FormData();
    form.append('wait_for_result', 'true');
    form.append('secure_mode', stored.secureMode ? 'true' : 'false');
    form.append('file', new Blob([new Uint8Array(audio.buffer)], { type: audio.mimeType }), audio.filename);

    let response: Response;
    try {
      response = await fetch(
        `https://api.hispeech.ai/api/v1/transcriptions/upload?stt_model=${encodeURIComponent(stored.modelId)}`,
        {
          method: 'POST',
          headers: { 'x-auth-token': apiKey },
          body: form,
          signal: AbortSignal.timeout(120_000),
        },
      );
    } catch {
      throw new BadRequestException('Could not reach HiSpeech.');
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new BadRequestException(this.errorText(raw, response.status));
    }

    let payload: { success?: unknown; error?: unknown; status?: unknown; transcription?: unknown; message?: unknown };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      throw new BadRequestException('HiSpeech returned an unreadable response.');
    }
    const failure = this.failed(payload);
    if (failure) throw new BadRequestException(failure);
    return {
      text: typeof payload.transcription === 'string' ? payload.transcription.trim() : '',
      languageCode: null,
    };
  }

  private store(apiKey: string, modelId: (typeof MODELS)[number], secureMode: boolean): StoredHiSpeechConfig {
    return {
      modelId,
      secureMode,
      apiKeyHint: secretHint(apiKey),
      apiKey: encryptSecret(apiKey, this.key()),
    };
  }

  private key() {
    return encryptionKeyFromEnv(this.configService.getOrThrow<string>('CREDENTIAL_ENCRYPTION_KEY'));
  }

  private readStored(config: Record<string, unknown>): StoredHiSpeechConfig {
    const apiKey = config.apiKey;
    if (
      (config.modelId !== 'model-23012026' && config.modelId !== 'model-01052025') ||
      typeof config.secureMode !== 'boolean' ||
      !apiKey ||
      typeof apiKey !== 'object' ||
      !('ciphertext' in apiKey)
    ) {
      throw new BadRequestException('Stored HiSpeech configuration is invalid.');
    }
    return config as unknown as StoredHiSpeechConfig;
  }

  private failed(payload: { success?: unknown; error?: unknown; status?: unknown; message?: unknown }) {
    const success = payload.success;
    const error = payload.error;
    const emptyError = error == null || error === '' || error === 'null' || error === 'None';
    if (success === false || success === 'false' || success === 0 || success === '0') {
      return emptyError ? 'HiSpeech could not transcribe that audio.' : String(error).slice(0, 300);
    }
    if (!emptyError) return String(error).slice(0, 300);
    if (typeof payload.status === 'number' && payload.status >= 400) {
      return String(payload.message || 'HiSpeech rejected the request.').slice(0, 300);
    }
    return null;
  }

  private errorText(raw: string, status: number) {
    try {
      const body = JSON.parse(raw) as { error?: unknown; message?: unknown };
      const message = body.error ?? body.message;
      if (typeof message === 'string' && message && message !== 'null' && message !== 'None') {
        return message.slice(0, 300);
      }
    } catch {
      return raw.trim().slice(0, 300) || `HiSpeech returned status ${status}.`;
    }
    return `HiSpeech returned status ${status}.`;
  }

  private fieldMessage(issues: { path: PropertyKey[] }[]) {
    const fields = issues.map((issue) => issue.path.join('.') || 'config').join(', ');
    return `Invalid HiSpeech configuration: ${fields}.`;
  }
}
