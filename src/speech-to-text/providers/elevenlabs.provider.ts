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
import {
  AudioInput,
  ConnectionTestResult,
  SpeechToTextProvider,
  TranscriptionResult,
} from './speech-to-text-provider';

const modelIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{1,64}$/, 'Model ID must contain only lowercase letters, numbers, and underscores.');

const languageSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value == null) return null;
    const trimmed = value.trim().toLowerCase();
    return trimmed.length === 0 ? null : trimmed;
  })
  .refine((value) => value === null || /^[a-z]{2,3}$/.test(value), {
    message: 'Language must be a 2- or 3-letter code, or left empty for automatic detection.',
  });

const createSchema = z.object({
  apiKey: z.string().trim().min(20).max(500),
  modelId: modelIdSchema.default('scribe_v2'),
  languageCode: languageSchema,
});

const updateSchema = z.object({
  apiKey: z.string().trim().min(20).max(500).optional(),
  modelId: modelIdSchema.optional(),
  languageCode: languageSchema,
});

interface StoredElevenLabsConfig {
  modelId: string;
  languageCode: string | null;
  apiKeyHint: string;
  apiKey: EncryptedSecret;
}

@Injectable()
export class ElevenLabsProvider implements SpeechToTextProvider {
  readonly id = SttProvider.ELEVENLABS;
  readonly supportsConnectionTest = true;

  constructor(private readonly configService: ConfigService) {}

  validateCreate(config: unknown): Record<string, unknown> {
    const parsed = createSchema.safeParse(config ?? {});
    if (!parsed.success) {
      throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    }
    return this.store(parsed.data.apiKey, parsed.data.modelId, parsed.data.languageCode ?? null) as unknown as Record<string, unknown>;
  }

  validateUpdate(config: unknown, existing: Record<string, unknown>): Record<string, unknown> {
    const current = this.readStored(existing);
    const parsed = updateSchema.safeParse(config ?? {});
    if (!parsed.success) {
      throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    }
    const nextKey = parsed.data.apiKey;
    if (!nextKey) {
      return {
        ...current,
        modelId: parsed.data.modelId ?? current.modelId,
        languageCode:
          parsed.data.languageCode === undefined ? current.languageCode : parsed.data.languageCode,
      } as unknown as Record<string, unknown>;
    }
    return this.store(
      nextKey,
      parsed.data.modelId ?? current.modelId,
      parsed.data.languageCode === undefined ? current.languageCode : parsed.data.languageCode,
    ) as unknown as Record<string, unknown>;
  }

  toPublic(config: Record<string, unknown>) {
    const stored = this.readStored(config);
    return {
      modelId: stored.modelId,
      languageCode: stored.languageCode,
      apiKeyHint: stored.apiKeyHint,
    };
  }

  engineKey(config: Record<string, unknown>) {
    const stored = this.readStored(config);
    return [this.id, stored.modelId, stored.languageCode ?? 'auto'].join('|');
  }

  async test(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const stored = this.readStored(config);
    const apiKey = decryptSecret(stored.apiKey, this.key());
    let response: Response;
    try {
      response = await fetch('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': apiKey },
      });
    } catch {
      return { ok: false, message: 'Could not reach ElevenLabs.' };
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: 'ElevenLabs rejected this API key.' };
    }
    if (!response.ok) {
      return { ok: false, message: `ElevenLabs returned status ${response.status}.` };
    }
    return { ok: true, message: 'ElevenLabs accepted this API key.' };
  }

  async transcribe(config: Record<string, unknown>, audio: AudioInput, signal?: AbortSignal): Promise<TranscriptionResult> {
    const stored = this.readStored(config);
    const apiKey = decryptSecret(stored.apiKey, this.key());
    const form = new FormData();
    form.append('model_id', stored.modelId);
    if (stored.languageCode) form.append('language_code', stored.languageCode);
    form.append('file', new Blob([new Uint8Array(audio.buffer)], { type: audio.mimeType }), audio.filename);

    let response: Response;
    try {
      response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': apiKey },
        body: form,
        signal,
      });
    } catch {
      throw new BadRequestException('Could not reach ElevenLabs.');
    }

    if (!response.ok) {
      throw new BadRequestException(await this.elevenLabsMessage(response));
    }

    const payload = (await response.json()) as { text?: unknown; language_code?: unknown };
    return {
      text: typeof payload.text === 'string' ? payload.text : '',
      languageCode: typeof payload.language_code === 'string' ? payload.language_code : stored.languageCode,
    };
  }

  private store(apiKey: string, modelId: string, languageCode: string | null): StoredElevenLabsConfig {
    return {
      modelId,
      languageCode,
      apiKeyHint: secretHint(apiKey),
      apiKey: encryptSecret(apiKey, this.key()),
    };
  }

  private key() {
    return encryptionKeyFromEnv(this.configService.getOrThrow<string>('CREDENTIAL_ENCRYPTION_KEY'));
  }

  private readStored(config: Record<string, unknown>): StoredElevenLabsConfig {
    const apiKey = config.apiKey;
    if (
      typeof config.modelId !== 'string' ||
      !apiKey ||
      typeof apiKey !== 'object' ||
      !('ciphertext' in apiKey)
    ) {
      throw new BadRequestException('Stored ElevenLabs configuration is invalid.');
    }
    return config as unknown as StoredElevenLabsConfig;
  }

  private async elevenLabsMessage(response: Response) {
    if (response.status === 401 || response.status === 403) {
      return 'ElevenLabs rejected this API key.';
    }
    const raw = await response.text();
    try {
      const body = JSON.parse(raw) as { detail?: { message?: string } | string };
      const detail = typeof body.detail === 'string' ? body.detail : body.detail?.message;
      if (detail) return detail.slice(0, 300);
    } catch {
      return `ElevenLabs returned status ${response.status}.`;
    }
    return `ElevenLabs returned status ${response.status}.`;
  }

  private fieldMessage(issues: { path: PropertyKey[] }[]) {
    const fields = issues.map((issue) => issue.path.join('.') || 'config').join(', ');
    return `Invalid ElevenLabs configuration: ${fields}.`;
  }
}
