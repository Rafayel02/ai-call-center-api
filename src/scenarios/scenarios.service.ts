import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateScenarioDto } from './dto/create-scenario.dto';
import { SaveScenarioGraphDto } from './dto/save-scenario-graph.dto';
import { emptyScenarioGraph, parseScenarioGraph, readScenarioGraph } from './scenario-graph';
import { LANGUAGE_NAME, ScenarioLanguage, applyTranslations, clearGraphModels, detectScript, emptyVoice, isScenarioLanguage, languageModelsFor, modelsOnGraph, spokenSample, spokenSlots, stampLanguage } from './scenario-languages';

const scenarioSummary = {
  id: true,
  name: true,
  description: true,
  icon: true,
  languages: true,
  active: true,
  createdAt: true,
  updatedAt: true,
  organization: { select: { id: true, name: true } },
} satisfies Prisma.ScenarioSelect;

@Injectable()
export class ScenariosService implements OnModuleInit {
  private readonly logger = new Logger(ScenariosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  async onModuleInit() {
    const rows = await this.prisma.scenario.findMany({ select: { id: true, languages: true, languageModels: true, graph: true } });
    for (const row of rows) {
      try {
        let languages = row.languages.filter(isScenarioLanguage);
        let graph: Prisma.JsonValue = row.graph;
        if (languages.length === 0) {
          const sample = spokenSample(graph);
          const script = detectScript(sample);
          const detected = script === 'en' ? ((await this.llm.detectLanguage(sample)) ?? 'en') : script;
          languages = [detected];
          graph = stampLanguage(graph, detected) as Prisma.JsonValue;
          this.logger.log(`Set scenario ${row.id} to ${LANGUAGE_NAME[detected]}.`);
        }
        const present = row.languageModels && typeof row.languageModels === 'object' && !Array.isArray(row.languageModels) ? (row.languageModels as Record<string, unknown>) : {};
        const lifted = modelsOnGraph(graph);
        const models = languageModelsFor(languages, present, false);
        let modelsChanged = false;
        languages.forEach((language, index) => {
          if (Object.prototype.hasOwnProperty.call(present, language)) return;
          models[language] = index === 0 ? lifted : emptyVoice();
          modelsChanged = true;
        });
        const cleared = clearGraphModels(graph);
        const graphChanged = JSON.stringify(cleared) !== JSON.stringify(graph);
        if (languages.join() === row.languages.join() && !modelsChanged && !graphChanged) continue;
        await this.prisma.scenario.update({
          where: { id: row.id },
          data: {
            languages,
            languageModels: models as unknown as Prisma.InputJsonValue,
            graph: cleared as Prisma.InputJsonValue,
          },
        });
        if (modelsChanged) this.logger.log(`Moved models for scenario ${row.id} onto ${LANGUAGE_NAME[languages[0]]}.`);
      } catch (error) {
        this.logger.error(`Could not prepare languages for scenario ${row.id}.`, error instanceof Error ? error.stack : undefined);
      }
    }
  }

  list() {
    return this.prisma.scenario.findMany({
      select: scenarioSummary,
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const scenario = await this.prisma.scenario.findUnique({
      where: { id },
      select: { ...scenarioSummary, graph: true, languageModels: true, phoneNumber: { select: { id: true, e164: true } } },
    });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    return presentScenario(scenario);
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
        languages: [...new Set(dto.languages)],
        languageModels: Object.fromEntries([...new Set(dto.languages)].map((language) => [language, emptyVoice()])) as unknown as Prisma.InputJsonValue,
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

  async addLanguage(id: string, language: ScenarioLanguage) {
    const scenario = await this.prisma.scenario.findUnique({ where: { id }, select: { languages: true, languageModels: true, graph: true } });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    const languages = scenario.languages.filter(isScenarioLanguage);
    if (languages.includes(language)) return this.get(id);
    const source = languages[0];
    if (!source) throw new BadRequestException('This scenario has no language yet.');
    const slots = spokenSlots(scenario.graph, source);
    const translated = await this.llm.translateLines(slots.flatMap((slot) => slot.lines), LANGUAGE_NAME[language]);
    const graph = applyTranslations(scenario.graph, language, slots, translated);
    const models = { ...languageModelsFor(languages, scenario.languageModels, false), [language]: emptyVoice() };
    await this.prisma.scenario.update({
      where: { id },
      data: {
        languages: [...languages, language],
        languageModels: models as unknown as Prisma.InputJsonValue,
        graph: graph as Prisma.InputJsonValue,
      },
    });
    return this.get(id);
  }

  async saveGraph(id: string, dto: SaveScenarioGraphDto) {
    const existing = await this.prisma.scenario.findUnique({ where: { id }, select: { languages: true } });
    if (!existing) throw new NotFoundException('Scenario not found.');
    const languages = existing.languages.filter(isScenarioLanguage);
    const graph = parseScenarioGraph(dto, languages);
    const languageModels = dto.languageModels === undefined ? undefined : languageModelsFor(languages, dto.languageModels, true);
    const ids = modelIds(languageModels);
    await this.assertModels(this.prisma.textToSpeechModel, ids.tts, 'Choose a text-to-speech model that exists.');
    await this.assertModels(this.prisma.speechToTextModel, ids.stt, 'Choose a speech-to-text model that exists.');
    await this.assertModels(this.prisma.llmModel, ids.llm, 'Choose an LLM that exists.');
    try {
      const scenario = await this.prisma.scenario.update({
        where: { id },
        data: {
          graph: graph as unknown as Prisma.InputJsonValue,
          ...(languageModels ? { languageModels: languageModels as unknown as Prisma.InputJsonValue } : {}),
        },
        select: { ...scenarioSummary, graph: true, languageModels: true, phoneNumber: { select: { id: true, e164: true } } },
      });
      return presentScenario(scenario);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Scenario not found.');
      }
      throw error;
    }
  }
}

function presentScenario<T extends { languages: string[]; languageModels: Prisma.JsonValue; graph: Prisma.JsonValue }>(scenario: T) {
  const languages = scenario.languages.filter(isScenarioLanguage);
  return {
    ...scenario,
    graph: readScenarioGraph(scenario.graph),
    languageModels: languageModelsFor(languages, scenario.languageModels, false),
  };
}

function modelIds(models: Record<string, { sttModelId: string | null; ttsModelId: string | null; llmModelId: string | null }> | undefined) {
  const stt = new Set<string>();
  const tts = new Set<string>();
  const llm = new Set<string>();
  for (const voice of Object.values(models ?? {})) {
    if (voice.sttModelId) stt.add(voice.sttModelId);
    if (voice.ttsModelId) tts.add(voice.ttsModelId);
    if (voice.llmModelId) llm.add(voice.llmModelId);
  }
  return { stt: [...stt], tts: [...tts], llm: [...llm] };
}
