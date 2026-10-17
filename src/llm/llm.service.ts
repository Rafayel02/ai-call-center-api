import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LlmProvider, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { CompleteTurnDto, CreateLlmModelDto, RouteCallDto, TestLlmDraftDto, UpdateLlmModelDto } from './dto/llm-model.dto';
import { ConversationMessage } from './inquiry-turn';
import { RouteTopic } from './topic-route';
import { ProviderRegistry } from './providers/provider.registry';
import { LlmProviderClient } from './providers/llm-provider';

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
  })
  .superRefine((value, context) => {
    const topics = value.topics ?? [];
    if (topics.length === 0) return;
    const ids = new Set(topics.map((topic) => topic.id));
    if (!value.defaultTopicId || ids.size !== topics.length || ids.has(value.defaultTopicId)) {
      context.addIssue({ code: 'custom', message: 'Each topic needs its own id.', path: ['topics'] });
    }
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

  async complete(id: string, dto: CompleteTurnDto) {
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
    return this.providers.get(model.provider).complete(model.config as Record<string, unknown>, {
      messages,
      note: parsed.data.note,
      topics: parsed.data.topics,
      defaultTopicId: parsed.data.defaultTopicId,
    });
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

  private runTest(provider: LlmProviderClient, config: Record<string, unknown>) {
    if (!provider.supportsConnectionTest || !provider.test) {
      throw new BadRequestException('This provider has no connection check.');
    }
    return provider.test(config);
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
