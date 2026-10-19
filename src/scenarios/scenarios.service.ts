import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { CreateScenarioDto } from './dto/create-scenario.dto';
import { SaveScenarioGraphDto } from './dto/save-scenario-graph.dto';
import { emptyScenarioGraph, parseScenarioGraph, readScenarioGraph, ScenarioGraph } from './scenario-graph';
import { fixedLines, graphModelIds, planScenario } from './scenario-plan';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly speech: TextToSpeechService,
  ) {}

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

  private async assertModels(
    model: { findMany(args: { where: { id: { in: string[] } }; select: { id: true } }): Promise<Array<{ id: string }>> },
    ids: string[],
    message: string,
  ) {
    if (ids.length === 0) return;
    const found = await model.findMany({ where: { id: { in: ids } }, select: { id: true } });
    if (found.length !== ids.length) throw new BadRequestException(message);
  }

  /** Refuses a graph that a call cannot run from Start to End, with the first problem found. */
  async assertRunnable(graph: ScenarioGraph) {
    const ids = graphModelIds(graph);
    const [tts, stt, llm] = await Promise.all([
      this.prisma.textToSpeechModel.findMany({ where: { id: { in: ids.tts } }, select: { id: true, enabled: true } }),
      this.prisma.speechToTextModel.findMany({ where: { id: { in: ids.stt } }, select: { id: true, enabled: true } }),
      this.prisma.llmModel.findMany({ where: { id: { in: ids.llm } }, select: { id: true, enabled: true } }),
    ]);
    const availability = (rows: Array<{ id: string; enabled: boolean }>) => new Map(rows.map((row) => [row.id, row.enabled]));
    const plan = planScenario(graph, { tts: availability(tts), stt: availability(stt), llm: availability(llm) });
    if (!plan.ok) throw new BadRequestException(plan.message);
  }

  /** Checks a graph for publishing and renders every fixed line as a phone clip, so a call never waits for ElevenLabs. */
  private async preparePublished(graph: ScenarioGraph) {
    await this.assertRunnable(graph);
    for (const line of fixedLines(graph)) {
      await this.speech.clip(line.modelId, line.text, 'ulaw_8000');
    }
  }

  async setActive(id: string, active: boolean) {
    if (active) {
      const scenario = await this.prisma.scenario.findUnique({ where: { id }, select: { graph: true } });
      if (!scenario) throw new NotFoundException('Scenario not found.');
      await this.preparePublished(readScenarioGraph(scenario.graph));
    }
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
    const ids = graphModelIds(graph);
    await this.assertModels(this.prisma.textToSpeechModel, ids.tts, 'Choose a text-to-speech model that exists.');
    await this.assertModels(this.prisma.speechToTextModel, ids.stt, 'Choose a speech-to-text model that exists.');
    await this.assertModels(this.prisma.llmModel, ids.llm, 'Choose an LLM that exists.');
    const current = await this.prisma.scenario.findUnique({ where: { id }, select: { active: true } });
    if (!current) throw new NotFoundException('Scenario not found.');
    if (current.active) await this.preparePublished(graph);
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
