import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateScenarioDto } from './dto/create-scenario.dto';
import { SaveScenarioGraphDto } from './dto/save-scenario-graph.dto';
import { emptyScenarioGraph, parseScenarioGraph, readScenarioGraph } from './scenario-graph';

const scenarioSummary = {
  id: true,
  name: true,
  description: true,
  icon: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  organization: { select: { id: true, name: true } },
} satisfies Prisma.ScenarioSelect;

@Injectable()
export class ScenariosService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.scenario.findMany({
      select: scenarioSummary,
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const scenario = await this.prisma.scenario.findUnique({
      where: { id },
      select: { ...scenarioSummary, graph: true, phoneNumber: { select: { id: true, e164: true } } },
    });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    return { ...scenario, graph: readScenarioGraph(scenario.graph) };
  }

  /** One number belongs to one scenario. Passing null detaches the current number. */
  async attachPhoneNumber(id: string, phoneNumberId: string | null) {
    const scenario = await this.prisma.scenario.findUnique({ where: { id }, select: { id: true } });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.phoneNumber.updateMany({ where: { scenarioId: id }, data: { scenarioId: null } });
        if (!phoneNumberId) return;
        const number = await tx.phoneNumber.findUnique({ where: { id: phoneNumberId }, select: { scenarioId: true } });
        if (!number) throw new NotFoundException('Phone number not found.');
        if (number.scenarioId && number.scenarioId !== id) throw new ConflictException('That number is already attached to a scenario.');
        await tx.phoneNumber.update({ where: { id: phoneNumberId }, data: { scenarioId: id } });
      });
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      throw error;
    }
    return this.get(id);
  }

  async create(dto: CreateScenarioDto, createdById: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: dto.organizationId },
      select: { id: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
    return this.prisma.scenario.create({
      data: {
        organizationId: dto.organizationId,
        name: dto.name,
        description: dto.description ?? null,
        icon: dto.icon,
        graph: emptyScenarioGraph() as unknown as Prisma.InputJsonValue,
        createdById,
      },
      select: scenarioSummary,
    });
  }

  private async assertModels(
    model: { findMany(args: { where: { id: { in: string[] } }; select: { id: true } }): Promise<Array<{ id: string }>> },
    ids: string[],
    message: string,
  ) {
    if (ids.length === 0) return;
    const found = await model.findMany({ where: { id: { in: ids } }, select: { id: true } });
    if (found.length !== ids.length) throw new BadRequestException(message);
  }

  async setActive(id: string, active: boolean) {
    try {
      return await this.prisma.scenario.update({
        where: { id },
        data: { active },
        select: scenarioSummary,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Scenario not found.');
      }
      throw error;
    }
  }

  async saveGraph(id: string, dto: SaveScenarioGraphDto) {
    const graph = parseScenarioGraph(dto);
    const ttsModelIds = new Set<string>();
    const sttModelIds = new Set<string>();
    const llmModelIds = new Set<string>();
    for (const node of graph.nodes) {
      if (node.type === 'tts' && node.data.modelId) ttsModelIds.add(node.data.modelId);
      if (node.type === 'loop' || node.type === 'closing') {
        if (node.data.ttsModelId) ttsModelIds.add(node.data.ttsModelId);
        if (node.data.sttModelId) sttModelIds.add(node.data.sttModelId);
        if (node.data.llmModelId) llmModelIds.add(node.data.llmModelId);
      }
    }
    await this.assertModels(this.prisma.textToSpeechModel, [...ttsModelIds], 'Choose a text-to-speech model that exists.');
    await this.assertModels(this.prisma.speechToTextModel, [...sttModelIds], 'Choose a speech-to-text model that exists.');
    await this.assertModels(this.prisma.llmModel, [...llmModelIds], 'Choose an LLM that exists.');
    try {
      const scenario = await this.prisma.scenario.update({
        where: { id },
        data: { graph: graph as unknown as Prisma.InputJsonValue },
        select: { graph: true },
      });
      return readScenarioGraph(scenario.graph);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Scenario not found.');
      }
      throw error;
    }
  }
}
