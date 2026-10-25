import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from '@prisma/client';
import { z } from 'zod';
import { decryptSecret, encryptSecret, encryptionKeyFromEnv, EncryptedSecret, secretHint } from '../../common/crypto/credential-cipher';
import { ConnectionTestResult, LlmClosingRequest, LlmCompletionRequest, LlmProviderClient, LlmRouteRequest } from './llm-provider';

const VOICE_ONLY = 'This Gemini key is only for live voice.';

const createSchema = z.object({
  apiKey: z.string().trim().min(20).max(500),
  modelId: z.literal('gemini-live').optional(),
});

const updateSchema = z.object({
  apiKey: z.string().trim().min(20).max(500).optional(),
  modelId: z.literal('gemini-live').optional(),
});

interface StoredGeminiConfig {
  modelId: 'gemini-live';
  apiKeyHint: string;
  apiKey: EncryptedSecret;
}

@Injectable()
export class GeminiProvider implements LlmProviderClient {
  readonly id = LlmProvider.GEMINI;
  readonly supportsConnectionTest = true;

  constructor(private readonly configService: ConfigService) {}

  validateCreate(config: unknown): Record<string, unknown> {
    const parsed = createSchema.safeParse(config ?? {});
    if (!parsed.success) throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    return this.store(parsed.data.apiKey) as unknown as Record<string, unknown>;
  }

  validateUpdate(config: unknown, existing: Record<string, unknown>): Record<string, unknown> {
    const current = this.readStored(existing);
    const parsed = updateSchema.safeParse(config ?? {});
    if (!parsed.success) throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    if (!parsed.data.apiKey) return current as unknown as Record<string, unknown>;
    return this.store(parsed.data.apiKey) as unknown as Record<string, unknown>;
  }

  toPublic(config: Record<string, unknown>) {
    const stored = this.readStored(config);
    return { modelId: stored.modelId, apiKeyHint: stored.apiKeyHint };
  }

  readApiKey(config: Record<string, unknown>) {
    return decryptSecret(this.readStored(config).apiKey, this.key());
  }

  async test(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const apiKey = this.readApiKey(config);
    let response: Response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`);
    } catch {
      return { ok: false, message: 'Could not reach Gemini.' };
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { ok: false, message: 'Gemini rejected this API key.' };
    }
    if (!response.ok) return { ok: false, message: `Gemini returned status ${response.status}.` };
    return { ok: true, message: 'Gemini accepted this API key.' };
  }

  complete(_config: Record<string, unknown>, _request: LlmCompletionRequest): Promise<never> {
    throw new BadRequestException(VOICE_ONLY);
  }

  route(_config: Record<string, unknown>, _request: LlmRouteRequest): Promise<never> {
    throw new BadRequestException(VOICE_ONLY);
  }

  judgeClosing(_config: Record<string, unknown>, _request: LlmClosingRequest): Promise<never> {
    throw new BadRequestException(VOICE_ONLY);
  }

  text(_config: Record<string, unknown>, _system: string, _user: string): Promise<never> {
    throw new BadRequestException(VOICE_ONLY);
  }

  private store(apiKey: string): StoredGeminiConfig {
    return { modelId: 'gemini-live', apiKeyHint: secretHint(apiKey), apiKey: encryptSecret(apiKey, this.key()) };
  }

  private key() {
    return encryptionKeyFromEnv(this.configService.getOrThrow<string>('CREDENTIAL_ENCRYPTION_KEY'));
  }

  private readStored(config: Record<string, unknown>): StoredGeminiConfig {
    const apiKey = config.apiKey;
    if (config.modelId !== 'gemini-live' || !apiKey || typeof apiKey !== 'object' || !('ciphertext' in apiKey)) {
      throw new BadRequestException('Stored Gemini configuration is invalid.');
    }
    return config as unknown as StoredGeminiConfig;
  }

  private fieldMessage(issues: { path: PropertyKey[] }[]) {
    const fields = issues.map((issue) => issue.path.join('.') || 'config').join(', ');
    return `Invalid Gemini configuration: ${fields}.`;
  }
}
