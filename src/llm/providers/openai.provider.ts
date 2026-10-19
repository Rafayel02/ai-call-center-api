import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from '@prisma/client';
import { z } from 'zod';
import {
  decryptSecret,
  encryptSecret,
  encryptionKeyFromEnv,
  EncryptedSecret,
  secretHint,
} from '../../common/crypto/credential-cipher';
import { inquirySystemPrompt, readInquiryTurn } from '../inquiry-turn';
import { readTopicChoice, topicRoutePrompt } from '../topic-route';
import { ConnectionTestResult, LlmCallTrace, LlmCompletionError, LlmCompletionRequest, LlmProviderClient, LlmRouteRequest, LlmUsage } from './llm-provider';

export const OPENAI_MODEL_IDS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'] as const;

const modelIdSchema = z.enum(OPENAI_MODEL_IDS);

const createSchema = z.object({
  apiKey: z.string().trim().min(20).max(500),
  modelId: modelIdSchema,
});

const updateSchema = z.object({
  apiKey: z.string().trim().min(20).max(500).optional(),
  modelId: modelIdSchema.optional(),
});

function inquiryResponseSchema(topics: Array<{ id: string }> | undefined, defaultTopicId: string | undefined) {
  const properties: Record<string, unknown> = {
    reply: { type: 'string' },
    inquiry: { type: ['string', 'null'] },
    phase: { type: 'string', enum: ['clarify', 'accepted'] },
  };
  const required = ['reply', 'inquiry', 'phase'];
  if (topics && topics.length > 0 && defaultTopicId) {
    properties.topicId = { type: 'string', enum: [...topics.map((topic) => topic.id), defaultTopicId] };
    required.push('topicId');
  }
  return { type: 'object', additionalProperties: false, properties, required };
}

interface StoredOpenAiConfig {
  modelId: (typeof OPENAI_MODEL_IDS)[number];
  apiKeyHint: string;
  apiKey: EncryptedSecret;
}

@Injectable()
export class OpenAiProvider implements LlmProviderClient {
  readonly id = LlmProvider.OPENAI;
  readonly supportsConnectionTest = true;

  constructor(private readonly configService: ConfigService) {}

  validateCreate(config: unknown): Record<string, unknown> {
    const parsed = createSchema.safeParse(config ?? {});
    if (!parsed.success) {
      throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    }
    return this.store(parsed.data.apiKey, parsed.data.modelId) as unknown as Record<string, unknown>;
  }

  validateUpdate(config: unknown, existing: Record<string, unknown>): Record<string, unknown> {
    const current = this.readStored(existing);
    const parsed = updateSchema.safeParse(config ?? {});
    if (!parsed.success) {
      throw new BadRequestException(this.fieldMessage(parsed.error.issues));
    }
    if (!parsed.data.apiKey) {
      return { ...current, modelId: parsed.data.modelId ?? current.modelId } as unknown as Record<string, unknown>;
    }
    return this.store(parsed.data.apiKey, parsed.data.modelId ?? current.modelId) as unknown as Record<string, unknown>;
  }

  toPublic(config: Record<string, unknown>) {
    const stored = this.readStored(config);
    return { modelId: stored.modelId, apiKeyHint: stored.apiKeyHint };
  }

  async test(config: Record<string, unknown>): Promise<ConnectionTestResult> {
    const stored = this.readStored(config);
    const apiKey = decryptSecret(stored.apiKey, this.key());
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch {
      return { ok: false, message: 'Could not reach OpenAI.' };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: 'OpenAI rejected this API key.' };
    }
    if (!response.ok) {
      return { ok: false, message: `OpenAI returned status ${response.status}.` };
    }
    return { ok: true, message: 'OpenAI accepted this API key.' };
  }

  async complete(config: Record<string, unknown>, request: LlmCompletionRequest) {
    const started = Date.now();
    const stored = this.readStored(config);
    const systemPrompt = inquirySystemPrompt(request.note, request.topics, request.defaultTopicId);
    const messages = request.messages.map((message) => ({
      role: message.role,
      content: message.interrupted
        ? `${message.content}\n[interrupted: the caller spoke over this and may not have heard it fully]`
        : message.content,
    }));
    const fail = (message: string, raw: unknown = null): never => {
      throw new LlmCompletionError(message, this.trace(systemPrompt, messages, raw, null, started));
    };
    const apiKey = decryptSecret(stored.apiKey, this.key());
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: stored.modelId,
          temperature: 0.3,
          max_completion_tokens: 400,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'inquiry_turn',
              strict: true,
              schema: inquiryResponseSchema(request.topics, request.defaultTopicId),
            },
          },
        }),
      });
    } catch {
      fail('Could not reach OpenAI.');
    }

    if (!response!.ok) {
      fail(await this.openAiMessage(response!), await this.readBody(response!));
    }

    const payload = (await response!.json()) as {
      choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    const message = payload.choices?.[0]?.message;
    if (message && typeof message.refusal === 'string' && message.refusal.trim()) {
      fail('OpenAI refused this turn.', payload);
    }
    if (!message || typeof message.content !== 'string' || !message.content.trim()) {
      fail('OpenAI did not return a reply.', payload);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message!.content as string);
    } catch {
      fail('OpenAI returned an unreadable reply.', payload);
    }
    const allowed = request.defaultTopicId ? [...(request.topics ?? []).map((topic) => topic.id), request.defaultTopicId] : undefined;
    try {
      const turn = readInquiryTurn(parsed, allowed, request.defaultTopicId);
      return { turn, trace: this.trace(systemPrompt, messages, payload, this.readUsage(payload.usage), started) };
    } catch (error) {
      fail(error instanceof Error ? error.message : 'OpenAI returned an unreadable reply.', payload);
    }
    throw new LlmCompletionError('OpenAI returned an unreadable reply.', this.trace(systemPrompt, messages, payload, null, started));
  }

  async route(config: Record<string, unknown>, request: LlmRouteRequest) {
    const stored = this.readStored(config);
    const apiKey = decryptSecret(stored.apiKey, this.key());
    const allowed = [...request.topics.map((topic) => topic.id), request.defaultTopicId];
    const history = request.messages.map((message) => ({
      role: message.role,
      content: message.interrupted
        ? `${message.content}\n[interrupted: the caller spoke over this and may not have heard it fully]`
        : message.content,
    }));
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: stored.modelId,
          temperature: 0,
          max_completion_tokens: 80,
          messages: [
            { role: 'system', content: topicRoutePrompt(request.inquiry, request.topics, request.defaultTopicId) },
            ...(history.length > 0 ? history : [{ role: 'user' as const, content: 'Choose a topic for this call.' }]),
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'topic_choice',
              strict: true,
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  topicId: { type: 'string', enum: allowed },
                },
                required: ['topicId'],
              },
            },
          },
        }),
      });
    } catch {
      throw new BadRequestException('Could not reach OpenAI.');
    }

    if (!response.ok) {
      throw new BadRequestException(await this.openAiMessage(response));
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }>;
    };
    const message = payload.choices?.[0]?.message;
    if (message && typeof message.refusal === 'string' && message.refusal.trim()) {
      throw new BadRequestException('OpenAI refused this turn.');
    }
    if (!message || typeof message.content !== 'string' || !message.content.trim()) {
      return { topicId: request.defaultTopicId };
    }
    try {
      return { topicId: readTopicChoice(JSON.parse(message.content), allowed, request.defaultTopicId) };
    } catch {
      return { topicId: request.defaultTopicId };
    }
  }

  private trace(
    systemPrompt: string,
    messages: Array<{ role: string; content: string }>,
    raw: unknown,
    usage: LlmUsage | null,
    started: number,
  ): LlmCallTrace {
    return { systemPrompt, messages, raw, usage, latencyMs: Date.now() - started };
  }

  private readUsage(usage: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } | undefined): LlmUsage | null {
    if (!usage) return null;
    const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
    const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;
    const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : null;
    if (promptTokens == null && completionTokens == null && totalTokens == null) return null;
    return {
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      totalTokens: totalTokens ?? 0,
    };
  }

  private async readBody(response: Response) {
    const raw = await response.clone().text();
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw.slice(0, 2000);
    }
  }

  private store(apiKey: string, modelId: StoredOpenAiConfig['modelId']): StoredOpenAiConfig {
    return {
      modelId,
      apiKeyHint: secretHint(apiKey),
      apiKey: encryptSecret(apiKey, this.key()),
    };
  }

  private key() {
    return encryptionKeyFromEnv(this.configService.getOrThrow<string>('CREDENTIAL_ENCRYPTION_KEY'));
  }

  private readStored(config: Record<string, unknown>): StoredOpenAiConfig {
    const apiKey = config.apiKey;
    if (
      typeof config.modelId !== 'string' ||
      !(OPENAI_MODEL_IDS as readonly string[]).includes(config.modelId) ||
      !apiKey ||
      typeof apiKey !== 'object' ||
      !('ciphertext' in apiKey)
    ) {
      throw new BadRequestException('Stored OpenAI configuration is invalid.');
    }
    return config as unknown as StoredOpenAiConfig;
  }

  private async openAiMessage(response: Response) {
    if (response.status === 401 || response.status === 403) {
      return 'OpenAI rejected this API key.';
    }
    const raw = await response.text();
    try {
      const body = JSON.parse(raw) as { error?: { message?: string } };
      if (body.error?.message) return body.error.message.slice(0, 300);
    } catch {
      return `OpenAI returned status ${response.status}.`;
    }
    return `OpenAI returned status ${response.status}.`;
  }

  private fieldMessage(issues: { path: PropertyKey[] }[]) {
    const fields = issues.map((issue) => issue.path.join('.') || 'config').join(', ');
    return `Invalid OpenAI configuration: ${fields}.`;
  }
}
