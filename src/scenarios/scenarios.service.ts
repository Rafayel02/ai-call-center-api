import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateScenarioDto } from './dto/create-scenario.dto';
import { SaveScenarioGraphDto } from './dto/save-scenario-graph.dto';
import { emptyScenarioGraph, parseScenarioGraph, readScenarioGraph } from './scenario-graph';
import { LANGUAGE_NAME, ScenarioLanguage, applyTranslations, clearGraphModels, detectScript, emptyVoice, isScenarioLanguage, languageModelsFor, modelsOnGraph, spokenSample, spokenSlots, stampLanguage } from './scenario-languages';
import { readVoiceMode, readVoicePrompt } from '../telephony/realtime-brief';
import { LEARN_SYSTEM, NOTES_SYSTEM, SOURCE_LIMIT, SOURCE_TEXT_LIMIT, VoiceSource, publicVoiceSource, readLearnedPrompt, readNotes, readTranslatedPrompt, readVoicePrompts, readVoiceSources, sourceBatches, translateSystem } from './voice-context';
import { PAGE_TEXT_LIMIT, THIN_SITE_PAGES, pageIdentity, siteHost } from './site-pages';
import { CrawledPage, crawlSite, textFromUpload } from './voice-sources';
import { readRealtimeModel } from '../telephony/realtime-models';

const scenarioSummary = {
  id: true,
  name: true,
  description: true,
  icon: true,
  languages: true,
  askLanguage: true,
  realtimeModel: true,
  voiceMode: true,
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
      select: { ...scenarioSummary, graph: true, languageModels: true, voicePrompt: true, voicePrompts: true, voiceSources: true, phoneNumber: { select: { id: true, e164: true } } },
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
    const prompts = dto.voicePrompts === undefined ? undefined : readVoicePrompts(dto.voicePrompts, dto.voicePrompt);
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
          ...(dto.askLanguage === undefined ? {} : { askLanguage: dto.askLanguage }),
          ...(dto.realtimeModel === undefined ? {} : { realtimeModel: dto.realtimeModel }),
          ...(dto.voiceMode === undefined ? {} : { voiceMode: dto.voiceMode }),
          ...(prompts ? { voicePrompts: prompts as unknown as Prisma.InputJsonValue, voicePrompt: prompts.hy } : dto.voicePrompt === undefined ? {} : { voicePrompt: dto.voicePrompt.trim() }),
        },
        select: { ...scenarioSummary, graph: true, languageModels: true, voicePrompt: true, voicePrompts: true, voiceSources: true, phoneNumber: { select: { id: true, e164: true } } },
      });
      return presentScenario(scenario);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Scenario not found.');
      }
      throw error;
    }
  }

  async addContextSource(id: string, input: { url?: string; name?: string; data?: string }) {
    const scenario = await this.prisma.scenario.findUnique({ where: { id }, select: { voiceSources: true } });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    const sources = readVoiceSources(scenario.voiceSources);
    if (sources.length >= SOURCE_LIMIT) throw new BadRequestException(`This context already has ${SOURCE_LIMIT} sources.`);
    if (input.url?.trim()) {
      const pages = await crawlSite(input.url.trim());
      const accepted = unseenPages(sources, pages).slice(0, SOURCE_LIMIT - sources.length);
      if (accepted.length === 0) throw new BadRequestException('Those pages are already in this context.');
      const next = [...sources, ...accepted];
      await this.prisma.scenario.update({ where: { id }, data: { voiceSources: next as unknown as Prisma.InputJsonValue } });
      return { voiceSources: next.map(publicVoiceSource), added: accepted.length };
    }
    const source = input.data && input.name?.trim() ? await this.fileSource(input.name.trim(), input.data) : null;
    if (!source) throw new BadRequestException('Add a link or a file.');
    const next = [...sources, source];
    await this.prisma.scenario.update({ where: { id }, data: { voiceSources: next as unknown as Prisma.InputJsonValue } });
    return { voiceSources: next.map(publicVoiceSource), added: 1 };
  }

  async removeContextSource(id: string, sourceId: string) {
    const scenario = await this.prisma.scenario.findUnique({ where: { id }, select: { voiceSources: true } });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    const sources = readVoiceSources(scenario.voiceSources);
    const next = sources.filter((source) => source.id !== sourceId);
    if (next.length === sources.length) throw new NotFoundException('That source was not found.');
    await this.prisma.scenario.update({ where: { id }, data: { voiceSources: next as unknown as Prisma.InputJsonValue } });
    return { voiceSources: next.map(publicVoiceSource) };
  }

  async learnContext(id: string, current: unknown) {
    const scenario = await this.prisma.scenario.findUnique({ where: { id }, select: { voicePrompt: true, voicePrompts: true, voiceSources: true } });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    let sources = readVoiceSources(scenario.voiceSources);
    if (sources.length === 0) throw new BadRequestException('Add a file or a link before learning.');
    sources = await this.expandThinSites(id, sources);
    const prompts = readVoicePrompts(current && typeof current === 'object' ? current : scenario.voicePrompts, scenario.voicePrompt);
    const notes = await this.notesFromSources(sources);
    if (!notes.trim()) throw new BadRequestException('Learning did not find facts in the sources.');
    const raw = await this.llm.writeJson(LEARN_SYSTEM, `Write the full reference from these notes. Keep every plan, price, and condition on its own entry. Do not turn this into a short welcome.\n\n${notes}`);
    let english: string;
    try {
      english = readLearnedPrompt(raw);
    } catch {
      throw new BadRequestException('Learning did not return an English prompt.');
    }
    const next = { ...prompts, en: english };
    await this.prisma.scenario.update({
      where: { id },
      data: { voicePrompts: next as unknown as Prisma.InputJsonValue, voicePrompt: next.hy },
    });
    return { voicePrompts: next, voiceSources: sources.map(publicVoiceSource) };
  }

  async translateContext(id: string, current: unknown) {
    const scenario = await this.prisma.scenario.findUnique({ where: { id }, select: { voicePrompt: true, voicePrompts: true, voiceSources: true } });
    if (!scenario) throw new NotFoundException('Scenario not found.');
    const prompts = readVoicePrompts(current && typeof current === 'object' ? current : scenario.voicePrompts, scenario.voicePrompt);
    if (!prompts.en.trim()) throw new BadRequestException('Write the English prompt before translating.');
    const sources = readVoiceSources(scenario.voiceSources);
    const [hy, ru] = await Promise.all([this.translatePrompt(prompts.en, 'hy'), this.translatePrompt(prompts.en, 'ru')]);
    const next = { ...prompts, hy, ru };
    await this.prisma.scenario.update({
      where: { id },
      data: { voicePrompts: next as unknown as Prisma.InputJsonValue, voicePrompt: next.hy },
    });
    return { voicePrompts: next, voiceSources: sources.map(publicVoiceSource) };
  }

  private async expandThinSites(id: string, sources: VoiceSource[]) {
    const hosts = new Map<string, VoiceSource[]>();
    for (const source of sources) {
      if (source.kind !== 'link' || !source.url) continue;
      const host = siteHost(source.url);
      if (!host) continue;
      const list = hosts.get(host) ?? [];
      list.push(source);
      hosts.set(host, list);
    }
    let next = sources.slice();
    for (const pages of hosts.values()) {
      if (pages.length >= THIN_SITE_PAGES) continue;
      const seed = pages.slice().sort((left, right) => (left.url?.length ?? 0) - (right.url?.length ?? 0))[0];
      if (!seed.url) continue;
      try {
        const crawled = await crawlSite(seed.url);
        for (const page of crawled) {
          const identity = pageIdentity(page.url);
          const index = next.findIndex((source) => source.url && pageIdentity(source.url) === identity);
          if (index >= 0) {
            const previous = next[index];
            next[index] = { ...previous, name: page.name, url: page.url, text: page.text.length + 200 < previous.text.length ? previous.text : page.text };
            continue;
          }
          if (next.length >= SOURCE_LIMIT) break;
          next.push({ id: randomUUID(), kind: 'link', name: page.name, url: page.url, text: page.text, createdAt: new Date().toISOString() });
        }
      } catch (error) {
        this.logger.warn(`Context site was not read: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    }
    if (sourceMark(next) !== sourceMark(sources)) {
      await this.prisma.scenario.update({ where: { id }, data: { voiceSources: next as unknown as Prisma.InputJsonValue } });
    }
    return next;
  }

  private async notesFromSources(sources: VoiceSource[]) {
    const batches = sourceBatches(sources);
    const notes = await mapPool(batches, 3, async (batch) => {
      let raw = '';
      try {
        raw = await this.llm.writeJson(NOTES_SYSTEM, batch);
        return readNotes(raw);
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        this.logger.warn(`Context notes were not readable: ${raw.slice(0, 300)}`);
        return '';
      }
    });
    const gathered = notes.filter(Boolean).join('\n\n').trim();
    if (gathered) return gathered.slice(0, 60_000);
    const pages = sources
      .map((source) => source.text.trim())
      .filter((text) => text.length >= 30)
      .map((text, index) => `Page ${index + 1}\n${text.slice(0, 12_000)}`)
      .join('\n\n')
      .slice(0, 60_000);
    if (!pages) throw new BadRequestException('Learning did not find facts in the sources.');
    return pages;
  }

  private async translatePrompt(english: string, language: 'hy' | 'ru') {
    const raw = await this.llm.writeJson(translateSystem(language), english, 'Add an enabled OpenAI model before translating.');
    try {
      return readTranslatedPrompt(raw);
    } catch {
      throw new BadRequestException(`Translation did not return the ${LANGUAGE_NAME[language]} prompt.`);
    }
  }

  private async fileSource(name: string, data: string): Promise<VoiceSource> {
    const text = (await textFromUpload(name, Buffer.from(data, 'base64'))).slice(0, SOURCE_TEXT_LIMIT);
    return { id: randomUUID(), kind: 'file', name: name.slice(0, 200), url: null, text, createdAt: new Date().toISOString() };
  }
}

function unseenPages(sources: VoiceSource[], pages: CrawledPage[]): VoiceSource[] {
  const seen = new Set(sources.map((source) => (source.url ? pageIdentity(source.url) : null)).filter((identity): identity is string => Boolean(identity)));
  const now = new Date().toISOString();
  const fresh: VoiceSource[] = [];
  for (const page of pages) {
    const identity = pageIdentity(page.url);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    fresh.push({ id: randomUUID(), kind: 'link', name: page.name, url: page.url.slice(0, 2000), text: page.text.slice(0, PAGE_TEXT_LIMIT), createdAt: now });
  }
  return fresh;
}

function sourceMark(sources: VoiceSource[]) {
  return sources.map((source) => `${source.url ?? source.id}\n${source.text}`).join('\n');
}

async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

function presentScenario<T extends { languages: string[]; languageModels: Prisma.JsonValue; graph: Prisma.JsonValue; realtimeModel: string; voiceMode: string; voicePrompt: string; voicePrompts: Prisma.JsonValue; voiceSources: Prisma.JsonValue }>(scenario: T) {
  const languages = scenario.languages.filter(isScenarioLanguage);
  const voicePrompts = readVoicePrompts(scenario.voicePrompts, scenario.voicePrompt);
  return {
    ...scenario,
    realtimeModel: readRealtimeModel(scenario.realtimeModel),
    voiceMode: readVoiceMode(scenario.voiceMode),
    voicePrompt: voicePrompts.hy || readVoicePrompt(scenario.voicePrompt),
    voicePrompts,
    voiceSources: readVoiceSources(scenario.voiceSources).map(publicVoiceSource),
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
