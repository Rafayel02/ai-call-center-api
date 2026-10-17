import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LlmProvider, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { CompleteTurnDto, CreateLlmModelDto, TestLlmDraftDto, UpdateLlmModelDto } from './dto/llm-model.dto';
import { ConversationMessage } from './inquiry-turn';
import { ProviderRegistry } from './providers/provider.registry';
import { LlmProviderClient } from './providers/llm-provider';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(4000),
  interrupted: z.boolean().optional(),
});

const completeSchema = z.object({
  instructions: z.string().trim().min(1).max(4000),
  messages: z.array(messageSchema).min(1).max(40),
  note: z.string().trim().max(1000).optional(),
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
      throw new BadRequestException('Describe the inquiry and include the conversation.');
    }
    const model = await this.findOrThrow(id);
    if (!model.enabled) throw new BadRequestException('This model is disabled.');
    const messages: ConversationMessage[] = parsed.data.messages.map((message) => ({
      role: message.role,
      content: message.content,
      interrupted: message.interrupted,
    }));
    return this.providers.get(model.provider).complete(model.config as Record<string, unknown>, {
      instructions: parsed.data.instructions,
      messages,
      note: parsed.data.note,
    });
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
