import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
      select: { ...scenarioSummary, graph: true },
    });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    return { ...scenario, graph: readScenarioGraph(scenario.graph) };
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

  async saveGraph(id: string, dto: SaveScenarioGraphDto) {
    const graph = parseScenarioGraph(dto);
    const modelIds = [
      ...new Set(
        graph.nodes.flatMap((node) =>
          node.type === 'tts' && 'modelId' in node.data && node.data.modelId ? [node.data.modelId] : [],
        ),
      ),
    ];
    if (modelIds.length > 0) {
      const found = await this.prisma.textToSpeechModel.findMany({
        where: { id: { in: modelIds } },
        select: { id: true },
      });
      if (found.length !== modelIds.length) {
        throw new BadRequestException('Choose a text-to-speech model that exists.');
      }
    }
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
