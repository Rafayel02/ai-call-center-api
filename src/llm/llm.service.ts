import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LlmProvider, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { CompleteTurnDto, CreateLlmModelDto, RouteCallDto, TestLlmDraftDto, UpdateLlmModelDto } from './dto/llm-model.dto';
import { ConversationMessage } from './inquiry-turn';
import { ReplyAssembler } from './reply-stream';
import { ExecutionContext } from '../scenario-executions/execution-context';
import { ScenarioExecutionsService } from '../scenario-executions/scenario-executions.service';
import { LlmCompletionError, LlmProviderClient } from './providers/llm-provider';
import { OpenAiProvider } from './providers/openai.provider';
import { ProviderRegistry } from './providers/provider.registry';
import { RouteTopic } from './topic-route';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(4000),
  interrupted: z.boolean().optional(),
});

const topicIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/);

const completeSchema = z
  .object({
    messages: z.array(messageSchema).min(1).max(40),
    note: z.string().trim().max(1000).optional(),
    topics: z
      .array(
        z.object({
          id: topicIdSchema,
          description: z.string().trim().min(1).max(240),
        }),
      )
      .max(8)
      .optional(),
    defaultTopicId: topicIdSchema.optional(),
    closingReturn: z.boolean().optional(),
    language: z.string().trim().max(40).optional(),
  })
  .superRefine((value, context) => {
    const topics = value.topics ?? [];
    if (topics.length === 0) return;
    const ids = new Set(topics.map((topic) => topic.id));
    if (!value.defaultTopicId || ids.size !== topics.length || ids.has(value.defaultTopicId)) {
      context.addIssue({ code: 'custom', message: 'Each topic needs its own id.', path: ['topics'] });
    }
  });

const closingSchema = z.object({
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(2000),
});

const routeSchema = z.object({
  inquiry: z.string().trim().max(500).optional(),
  messages: z.array(messageSchema).max(40),
  topics: z
    .array(
      z.object({
        id: topicIdSchema,
        description: z.string().trim().min(1).max(240),
      }),
    )
    .max(8),
  defaultTopicId: topicIdSchema,
});

@Injectable()
export class LlmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: ProviderRegistry,
    private readonly executions: ScenarioExecutionsService,
  ) {}

  providersAvailable() {
    return this.providers.list();
  }

  async list() {
    const models = await this.prisma.llmModel.findMany({
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    return models.map((model) => this.present(model));
  }

  async get(id: string) {
    return this.present(await this.findOrThrow(id));
  }

  async create(dto: CreateLlmModelDto, userId: string) {
    const provider = this.providers.get(dto.provider);
    const config = provider.validateCreate(dto.config);
    const model = await this.prisma.llmModel.create({
      data: {
        name: dto.name.trim(),
        provider: dto.provider,
        enabled: dto.enabled ?? true,
        config: config as Prisma.InputJsonValue,
        createdById: userId,
      },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    return this.present(model);
  }

  async update(id: string, dto: UpdateLlmModelDto) {
    const existing = await this.findOrThrow(id);
    const provider = this.providers.get(existing.provider);
    const config = dto.config ? provider.validateUpdate(dto.config, existing.config as Record<string, unknown>) : undefined;
    const model = await this.prisma.llmModel.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        enabled: dto.enabled,
        config: config as Prisma.InputJsonValue | undefined,
      },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    return this.present(model);
  }

  async remove(id: string) {
    await this.findOrThrow(id);
    await this.prisma.llmModel.delete({ where: { id } });
    return { ok: true };
  }

  async testStored(id: string) {
    const model = await this.findOrThrow(id);
    return this.runTest(this.providers.get(model.provider), model.config as Record<string, unknown>);
  }

  async testDraft(dto: TestLlmDraftDto) {
    const provider = this.providers.get(dto.provider);
    return this.runTest(provider, provider.validateCreate(dto.config));
  }

  async complete(id: string, dto: CompleteTurnDto, execution: ExecutionContext | null = null) {
    const parsed = completeSchema.safeParse(dto);
    if (!parsed.success) {
      const topicIssue = parsed.error.issues.some((issue) => issue.path[0] === 'topics' || issue.path[0] === 'defaultTopicId');
      throw new BadRequestException(topicIssue ? 'Describe each topic before choosing a direction.' : 'Include the conversation.');
    }
    const model = await this.findOrThrow(id);
    if (!model.enabled) throw new BadRequestException('This model is disabled.');
    const messages: ConversationMessage[] = parsed.data.messages.map((message) => ({
      role: message.role,
      content: message.content,
      interrupted: message.interrupted,
    }));
    const request = {
      messages,
      note: parsed.data.note,
      topics: parsed.data.topics,
      defaultTopicId: parsed.data.defaultTopicId,
      closingReturn: parsed.data.closingReturn === true,
      language: parsed.data.language,
    };
    const snapshot = {
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
      providerModel: this.providers.get(model.provider).toPublic(model.config as Record<string, unknown>).modelId,
    };
    try {
      const result = await this.providers.get(model.provider).complete(model.config as Record<string, unknown>, request);
      await this.executions.recordLlm(execution, {
        model: snapshot,
        systemPrompt: result.trace.systemPrompt,
        messages: result.trace.messages,
        note: request.note ?? null,
        topics: request.topics ?? null,
        defaultTopicId: request.defaultTopicId ?? null,
        raw: result.trace.raw,
        turn: result.turn,
        latencyMs: result.trace.latencyMs,
        usage: result.trace.usage,
      });
      return result.turn;
    } catch (error) {
      const trace = error instanceof LlmCompletionError ? error.trace : null;
      await this.executions.recordLlm(execution, {
        model: snapshot,
        systemPrompt: trace?.systemPrompt ?? '',
        messages: trace?.messages ?? messages,
        note: request.note ?? null,
        topics: request.topics ?? null,
        defaultTopicId: request.defaultTopicId ?? null,
        raw: trace?.raw ?? null,
        latencyMs: trace?.latencyMs ?? 0,
        usage: null,
        error: error instanceof Error ? error.message : 'The model did not answer.',
      });
      if (error instanceof LlmCompletionError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /** Speaks the reply sentence by sentence while the rest of the turn is still generating. */
  stream(id: string, dto: CompleteTurnDto, execution: ExecutionContext | null = null) {
    const parsed = completeSchema.safeParse(dto);
    if (!parsed.success) {
      const topicIssue = parsed.error.issues.some((issue) => issue.path[0] === 'topics' || issue.path[0] === 'defaultTopicId');
      throw new BadRequestException(topicIssue ? 'Describe each topic before choosing a direction.' : 'Include the conversation.');
    }
    const messages: ConversationMessage[] = parsed.data.messages.map((message) => ({
      role: message.role,
      content: message.content,
      interrupted: message.interrupted,
    }));
    const request = {
      messages,
      note: parsed.data.note,
      topics: parsed.data.topics,
      defaultTopicId: parsed.data.defaultTopicId,
      closingReturn: parsed.data.closingReturn === true,
      language: parsed.data.language,
    };
    const assembler = new ReplyAssembler();
    const queue: string[] = [];
    let waiting: ((sentence: string | null) => void) | null = null;
    let closed = false;
    const push = (sentence: string | null) => {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(sentence);
        return;
      }
      if (sentence == null) closed = true;
      else queue.push(sentence);
    };
    const sentences = {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const sentence = await new Promise<string | null>((resolve) => {
            const next = queue.shift();
            if (next != null) {
              resolve(next);
              return;
            }
            if (closed) {
              resolve(null);
              return;
            }
            waiting = resolve;
          });
          if (sentence == null) return;
          yield sentence;
        }
      },
    };
    const turn = (async () => {
      let snapshot: { modelId: string; modelName: string; provider: LlmProvider; providerModel: string } | null = null;
      try {
        const model = await this.findOrThrow(id);
        if (!model.enabled) throw new BadRequestException('This model is disabled.');
        const provider = this.providers.get(model.provider);
        snapshot = {
          modelId: model.id,
          modelName: model.name,
          provider: model.provider,
          providerModel: provider.toPublic(model.config as Record<string, unknown>).modelId,
        };
        if (!provider.stream) throw new BadRequestException('This model cannot stream a reply.');
        const streamed = provider.stream(model.config as Record<string, unknown>, request);
        for await (const delta of streamed.deltas) {
          for (const sentence of assembler.push(delta)) push(sentence);
          if (assembler.replyClosed) break;
        }
        push(null);
        const result = await streamed.result;
        await this.executions.recordLlm(execution, {
          model: snapshot,
          systemPrompt: result.trace.systemPrompt,
          messages: result.trace.messages,
          note: request.note ?? null,
          topics: request.topics ?? null,
          defaultTopicId: request.defaultTopicId ?? null,
          raw: result.trace.raw,
          turn: result.turn,
          latencyMs: result.trace.latencyMs,
          usage: result.trace.usage,
        });
        return result.turn;
      } catch (error) {
        if (snapshot) {
          const trace = error instanceof LlmCompletionError ? error.trace : null;
          await this.executions.recordLlm(execution, {
            model: snapshot,
            systemPrompt: trace?.systemPrompt ?? '',
            messages: trace?.messages ?? messages,
            note: request.note ?? null,
            topics: request.topics ?? null,
            defaultTopicId: request.defaultTopicId ?? null,
            raw: trace?.raw ?? null,
            latencyMs: trace?.latencyMs ?? 0,
            usage: null,
            error: error instanceof Error ? error.message : 'The model did not answer.',
          });
        }
        if (error instanceof LlmCompletionError) throw new BadRequestException(error.message);
        throw error;
      } finally {
        push(null);
      }
    })();
    return { sentences, turn };
  }

  async writeJson(system: string, user: string, missing = 'Add an enabled OpenAI model before learning.') {
    const model = await this.prisma.llmModel.findFirst({ where: { enabled: true, provider: 'OPENAI' }, orderBy: { createdAt: 'asc' } });
    if (!model) throw new BadRequestException(missing);
    return this.providers.get(model.provider).text(model.config as Record<string, unknown>, system, user);
  }

  async embed(input: string[]) {
    if (input.length === 0) return [];
    const model = await this.prisma.llmModel.findFirst({ where: { enabled: true, provider: 'OPENAI' }, orderBy: { createdAt: 'asc' } });
    if (!model) throw new BadRequestException('Add an enabled OpenAI model before learning.');
    const client = this.providers.get(model.provider);
    if (!(client instanceof OpenAiProvider)) throw new BadRequestException('Add an enabled OpenAI model before learning.');
    return client.embed(model.config as Record<string, unknown>, input);
  }

  async translateLines(lines: string[], targetName: string) {
    const pending = lines.map((line, index) => (line.trim() ? index : -1)).filter((index) => index >= 0);
    if (pending.length === 0) return lines.map(() => '');
    const model = await this.firstEnabled();
    const raw = await this.providers.get(model.provider).text(
      model.config as Record<string, unknown>,
      `Translate each line into ${targetName}. Keep the same order and the same number of lines. Return JSON {"lines":["..."]}.`,
      JSON.stringify({ lines: pending.map((index) => lines[index]) }),
    );
    const translated = readLineList(raw);
    if (translated.length !== pending.length) throw new BadRequestException('Translation did not return every line.');
    const result = lines.map(() => '');
    pending.forEach((index, offset) => {
      result[index] = translated[offset];
    });
    return result;
  }

  async detectLanguage(sample: string): Promise<'hy' | 'en' | 'ru' | null> {
    const model = await this.prisma.llmModel.findFirst({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
    if (!model || !sample.trim()) return null;
    try {
      const raw = await this.providers.get(model.provider).text(
        model.config as Record<string, unknown>,
        'Detect the language of the text. Reply with JSON {"language":"hy"} for Armenian, {"language":"en"} for English, or {"language":"ru"} for Russian.',
        sample.slice(0, 4000),
      );
      const parsed = JSON.parse(raw) as { language?: unknown };
      return parsed.language === 'hy' || parsed.language === 'en' || parsed.language === 'ru' ? parsed.language : null;
    } catch {
      return null;
    }
  }

  private async firstEnabled() {
    const model = await this.prisma.llmModel.findFirst({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });
    if (!model) throw new BadRequestException('Add an LLM before adding a language.');
    return model;
  }

  async route(id: string, dto: RouteCallDto) {
    const parsed = routeSchema.safeParse(dto);
    if (!parsed.success) throw new BadRequestException('Describe each topic before choosing a direction.');
    const topics: RouteTopic[] = parsed.data.topics;
    const ids = new Set(topics.map((topic) => topic.id));
    if (ids.size !== topics.length || ids.has(parsed.data.defaultTopicId)) {
      throw new BadRequestException('Each topic needs its own id.');
    }
    const model = await this.findOrThrow(id);
    if (!model.enabled) throw new BadRequestException('This model is disabled.');
    const messages: ConversationMessage[] = parsed.data.messages.map((message) => ({
      role: message.role,
      content: message.content,
      interrupted: message.interrupted,
    }));
    const choice = await this.providers.get(model.provider).route(model.config as Record<string, unknown>, {
      inquiry: parsed.data.inquiry,
      messages,
      topics,
      defaultTopicId: parsed.data.defaultTopicId,
    });
    const allowed = new Set([...ids, parsed.data.defaultTopicId]);
    return { topicId: allowed.has(choice.topicId) ? choice.topicId : parsed.data.defaultTopicId };
  }

  async judgeClosing(id: string, dto: unknown, execution: ExecutionContext | null) {
    const parsed = closingSchema.safeParse(dto);
    if (!parsed.success) throw new BadRequestException('The closing question and the caller answer are required.');
    const model = await this.findOrThrow(id);
    if (!model.enabled) throw new BadRequestException('This model is disabled.');
    const provider = this.providers.get(model.provider);
    const snapshot = {
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
      providerModel: provider.toPublic(model.config as Record<string, unknown>).modelId,
    };
    const request = { question: parsed.data.question, answer: parsed.data.answer };
    try {
      const result = await provider.judgeClosing(model.config as Record<string, unknown>, request);
      await this.executions.recordLlm(execution, {
        model: snapshot,
        systemPrompt: result.trace.systemPrompt,
        messages: result.trace.messages,
        raw: result.trace.raw,
        turn: { outcome: result.outcome },
        latencyMs: result.trace.latencyMs,
        usage: result.trace.usage,
      });
      return { outcome: result.outcome };
    } catch (error) {
      const trace = error instanceof LlmCompletionError ? error.trace : null;
      await this.executions.recordLlm(execution, {
        model: snapshot,
        systemPrompt: trace?.systemPrompt ?? '',
        messages: trace?.messages ?? [{ role: 'user', content: request.answer }],
        raw: trace?.raw ?? null,
        latencyMs: trace?.latencyMs ?? 0,
        usage: null,
        error: error instanceof Error ? error.message : 'The model did not answer.',
      });
      if (error instanceof LlmCompletionError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private runTest(provider: LlmProviderClient, config: Record<string, unknown>) {
    if (!provider.supportsConnectionTest || !provider.test) {
      throw new BadRequestException('This provider has no connection check.');
    }
    return provider.test(config);
  }

  async realtimeKey(which: LlmProvider = 'OPENAI') {
    const model = await this.prisma.llmModel.findFirst({ where: { enabled: true, provider: which }, orderBy: { createdAt: 'asc' } });
    if (!model) return null;
    const provider = this.providers.get(model.provider);
    if (!provider.readApiKey) return null;
    try {
      return provider.readApiKey(model.config as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  private async findOrThrow(id: string) {
    const model = await this.prisma.llmModel.findUnique({
      where: { id },
      include: { createdBy: { select: { id: true, email: true } } },
    });
    if (!model) throw new NotFoundException('LLM not found.');
    return model;
  }

  private present(model: {
    id: string;
    name: string;
    provider: LlmProvider;
    enabled: boolean;
    config: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
    createdBy: { id: string; email: string };
  }) {
    const provider = this.providers.get(model.provider);
    return {
      id: model.id,
      name: model.name,
      provider: model.provider,
      enabled: model.enabled,
      config: provider.toPublic(model.config as Record<string, unknown>),
      createdAt: model.createdAt,
      updatedAt: model.updatedAt,
      createdBy: model.createdBy,
    };
  }
}

function readLineList(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException('Translation did not return every line.');
  }
  const lines = parsed && typeof parsed === 'object' && 'lines' in parsed ? (parsed as { lines?: unknown }).lines : null;
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== 'string')) {
    throw new BadRequestException('Translation did not return every line.');
  }
  return lines;
}
