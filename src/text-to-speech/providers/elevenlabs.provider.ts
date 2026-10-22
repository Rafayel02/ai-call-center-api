import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TtsProvider } from '@prisma/client';
import { z } from 'zod';
import {
  decryptSecret,
  encryptSecret,
  encryptionKeyFromEnv,
  EncryptedSecret,
  secretHint,
} from '../../common/crypto/credential-cipher';
import { ConnectionTestResult, TextToSpeechProvider, TtsVoice } from './text-to-speech-provider';

const modelIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{1,64}$/, 'Model ID must contain only lowercase letters, numbers, and underscores.');

const voiceIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Choose a voice from this ElevenLabs account.');

const apiKeySchema = z.string().trim().min(20).max(500);

const createSchema = z.object({
  apiKey: apiKeySchema,
  modelId: modelIdSchema.default('eleven_v3'),
  voiceId: voiceIdSchema,
});

const updateSchema = z.object({
  apiKey: apiKeySchema.optional(),
  modelId: modelIdSchema.optional(),
  voiceId: voiceIdSchema.optional(),
});

const keySchema = z.object({
  apiKey: apiKeySchema,
});

interface StoredElevenLabsConfig {
  modelId: string;
  voiceId: string;
  voiceName: string;
  apiKeyHint: string;
  apiKey: EncryptedSecret;
}

@Injectable()
export class ElevenLabsTtsProvider implements TextToSpeechProvider {
  readonly id = TtsProvider.ELEVENLABS;
  readonly supportsConnectionTest = true;

  constructor(private readonly configService: ConfigService) {}

  async validateCreate(config: unknown): Promise<Record<string, unknown>> {
    const parsed = createSchema.safeParse(config ?? {});
    if (!parsed.success) throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    const voiceName = await this.lookupVoice(parsed.data.apiKey, parsed.data.voiceId);
    return this.store(parsed.data.apiKey, parsed.data.modelId, parsed.data.voiceId, voiceName) as unknown as Record<string, unknown>;
  }

  async validateUpdate(config: unknown, existing: Record<string, unknown>): Promise<Record<string, unknown>> {
    const current = this.readStored(existing);
    const parsed = updateSchema.safeParse(config ?? {});
    if (!parsed.success) throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    const modelId = parsed.data.modelId ?? current.modelId;
    const voiceId = parsed.data.voiceId ?? current.voiceId;
    if (!parsed.data.apiKey && voiceId === current.voiceId) {
      return { ...current, modelId } as unknown as Record<string, unknown>;
    }
    const apiKey = parsed.data.apiKey ?? decryptSecret(current.apiKey, this.key());
    const voiceName = await this.lookupVoice(apiKey, voiceId);
    return this.store(apiKey, modelId, voiceId, voiceName) as unknown as Record<string, unknown>;
  }

  toPublic(config: Record<string, unknown>) {
    const stored = this.readStored(config);
    return {
      modelId: stored.modelId,
      voiceId: stored.voiceId,
      voiceName: stored.voiceName,
      apiKeyHint: stored.apiKeyHint,
    };
  }

  async test(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const stored = this.readStored(config);
    return this.testApiKey(decryptSecret(stored.apiKey, this.key()));
  }

  async testDraft(config: unknown): Promise<ConnectionTestResult> {
    const parsed = keySchema.safeParse(config ?? {});
    if (!parsed.success) throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    return this.testApiKey(parsed.data.apiKey);
  }

  async listVoices(config: unknown): Promise<TtsVoice[]> {
    const parsed = keySchema.safeParse(config ?? {});
    if (!parsed.success) throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    return this.fetchVoices(parsed.data.apiKey);
  }

  listStoredVoices(config: Record<string, unknown>): Promise<TtsVoice[]> {
    const stored = this.readStored(config);
    return this.fetchVoices(decryptSecret(stored.apiKey, this.key()));
  }

  async speak(config: Record<string, unknown>, text: string, format = 'mp3_44100_128'): Promise<Buffer> {
    const stored = this.readStored(config);
    const apiKey = decryptSecret(stored.apiKey, this.key());
    let response: Response;
    try {
      response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(stored.voiceId)}?output_format=${encodeURIComponent(format)}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: format.startsWith('ulaw') ? 'audio/basic' : 'audio/mpeg',
          },
          body: JSON.stringify({ text, model_id: stored.modelId }),
        },
      );
    } catch {
      throw new BadRequestException('Could not reach ElevenLabs.');
    }
    if (!response.ok) throw new BadRequestException(await this.elevenLabsMessage(response));
    return Buffer.from(await response.arrayBuffer());
  }

  async speakStream(config: Record<string, unknown>, text: string, format: string, onChunk: (chunk: Buffer) => void) {
    const stored = this.readStored(config);
    const apiKey = decryptSecret(stored.apiKey, this.key());
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(stored.voiceId)}/stream`);
    url.searchParams.set('output_format', format);
    url.searchParams.set('optimize_streaming_latency', '3');
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: format.startsWith('ulaw') ? 'audio/basic' : 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: stored.modelId }),
      });
    } catch {
      throw new BadRequestException('Could not reach ElevenLabs.');
    }
    if (!response.ok) throw new BadRequestException(await this.elevenLabsMessage(response));
    if (!response.body) {
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length) onChunk(audio);
      return audio;
    }
    const reader = response.body.getReader();
    const parts: Buffer[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (!chunk.length) continue;
      parts.push(chunk);
      onChunk(chunk);
    }
    return Buffer.concat(parts);
  }

  private async testApiKey(apiKey: string): Promise<ConnectionTestResult> {
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
    if (!response.ok) return { ok: false, message: `ElevenLabs returned status ${response.status}.` };
    return { ok: true, message: 'ElevenLabs accepted this API key.' };
  }

  private async lookupVoice(apiKey: string, voiceId: string) {
    let response: Response;
    try {
      response = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
        headers: { 'xi-api-key': apiKey },
      });
    } catch {
      throw new BadRequestException('Could not reach ElevenLabs.');
    }
    if (response.status === 401 || response.status === 403) {
      throw new BadRequestException('ElevenLabs rejected this API key.');
    }
    if (response.status === 404) throw new BadRequestException('ElevenLabs does not have that voice.');
    if (!response.ok) throw new BadRequestException(await this.elevenLabsMessage(response));
    const body = (await response.json()) as { name?: unknown };
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : voiceId;
    return name.slice(0, 120);
  }

  private async fetchVoices(apiKey: string): Promise<TtsVoice[]> {
    const voices: TtsVoice[] = [];
    let token: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url = new URL('https://api.elevenlabs.io/v2/voices');
      url.searchParams.set('page_size', '100');
      url.searchParams.set('include_total_count', 'false');
      if (token) url.searchParams.set('next_page_token', token);
      let response: Response;
      try {
        response = await fetch(url, { headers: { 'xi-api-key': apiKey } });
      } catch {
        throw new BadRequestException('Could not reach ElevenLabs.');
      }
      if (response.status === 401 || response.status === 403) {
        throw new BadRequestException('ElevenLabs rejected this API key.');
      }
      if (!response.ok) throw new BadRequestException(await this.elevenLabsMessage(response));
      const body = (await response.json()) as {
        voices?: { voice_id?: unknown; name?: unknown }[];
        has_more?: unknown;
        next_page_token?: unknown;
      };
      for (const voice of body.voices ?? []) {
        if (typeof voice.voice_id !== 'string' || !voice.voice_id) continue;
        const name = typeof voice.name === 'string' && voice.name.trim() ? voice.name.trim() : voice.voice_id;
        voices.push({ id: voice.voice_id, name: name.slice(0, 120) });
      }
      if (body.has_more !== true || typeof body.next_page_token !== 'string' || !body.next_page_token) break;
      token = body.next_page_token;
    }
    const unique = new Map(voices.map((voice) => [voice.id, voice]));
    return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private store(apiKey: string, modelId: string, voiceId: string, voiceName: string): StoredElevenLabsConfig {
    return {
      modelId,
      voiceId,
      voiceName,
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
      typeof config.voiceId !== 'string' ||
      typeof config.voiceName !== 'string' ||
      !apiKey ||
      typeof apiKey !== 'object' ||
      !('ciphertext' in apiKey)
    ) {
      throw new BadRequestException('Stored ElevenLabs configuration is invalid.');
    }
    return config as unknown as StoredElevenLabsConfig;
  }

  private async elevenLabsMessage(response: Response) {
    if (response.status === 401 || response.status === 403) return 'ElevenLabs rejected this API key.';
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
