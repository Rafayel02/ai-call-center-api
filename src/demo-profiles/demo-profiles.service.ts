import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { readVoiceMode, readVoicePrompt } from '../telephony/realtime-brief';
import { readRealtimeModel } from '../telephony/realtime-models';
import { DEMO_LANGUAGES, DemoLanguage, SaveDemoProfileDto, StartDemoSessionDto } from './dto/save-demo-profile.dto';
import { ProfileCopy, TEAM_PROFILE } from './team-profile';

const profileSelect = {
  id: true,
  key: true,
  displayName: true,
  scenarioId: true,
  defaultLanguage: true,
  enabled: true,
  accent: true,
  logoUrl: true,
  copy: true,
  createdAt: true,
  updatedAt: true,
  scenario: { select: { id: true, name: true, languages: true, languageModels: true, realtimeModel: true, voiceMode: true, voicePrompt: true } },
} satisfies Prisma.DemoProfileSelect;

type ProfileRow = Prisma.DemoProfileGetPayload<{ select: typeof profileSelect }>;

export interface VoiceIds {
  sttModelId: string | null;
  ttsModelId: string | null;
  llmModelId: string | null;
}

const UNAVAILABLE = 'The live voice demo is temporarily unavailable.';
const PROFILE_UNAVAILABLE = 'The requested personalized demo is unavailable.';

@Injectable()
export class DemoProfilesService implements OnModuleInit {
  private readonly logger = new Logger(DemoProfilesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const existing = await this.prisma.demoProfile.findUnique({ where: { key: TEAM_PROFILE.key }, select: { id: true } });
    if (existing) return;

    const matches = await this.prisma.scenario.findMany({
      where: {
        OR: [
          { name: { equals: 'Team Telecom Armenia', mode: 'insensitive' } },
          { name: { equals: 'My Team', mode: 'insensitive' } },
          { name: { contains: 'My Team guidance', mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true },
    });
    const scenarioId = matches.length === 1 ? matches[0].id : null;
    await this.prisma.demoProfile.create({
      data: {
        key: TEAM_PROFILE.key,
        displayName: TEAM_PROFILE.displayName,
        scenarioId,
        defaultLanguage: TEAM_PROFILE.defaultLanguage,
        enabled: true,
        accent: TEAM_PROFILE.accent,
        copy: TEAM_PROFILE.copy,
      },
    });
    if (scenarioId) this.logger.log(`Created the Team demo profile on scenario ${matches[0]?.name}.`);
    else this.logger.log('Created the Team demo profile without a scenario. Assign one before the live demo can start.');
  }

  async list() {
    const rows = await this.prisma.demoProfile.findMany({ select: profileSelect, orderBy: { createdAt: 'desc' } });
    return rows.map((row) => this.presentAdmin(row));
  }

  async create(dto: SaveDemoProfileDto) {
    try {
      const row = await this.prisma.demoProfile.create({ data: await this.toData(dto), select: profileSelect });
      return this.presentAdmin(row);
    } catch (error) {
      this.rethrowKnown(error);
    }
  }

  async update(id: string, dto: SaveDemoProfileDto) {
    await this.requireProfile(id);
    try {
      const row = await this.prisma.demoProfile.update({ where: { id }, data: await this.toData(dto), select: profileSelect });
      return this.presentAdmin(row);
    } catch (error) {
      this.rethrowKnown(error);
    }
  }

  async remove(id: string) {
    await this.requireProfile(id);
    await this.prisma.demoProfile.delete({ where: { id } });
    return { ok: true };
  }

  async publicProfile(key: string) {
    const row = await this.enabledProfile(key);
    const ready = readyLanguages(row.scenario);
    return {
      key: row.key,
      displayName: row.displayName,
      defaultLanguage: row.defaultLanguage,
      accent: row.accent,
      logoUrl: row.logoUrl,
      demoAvailable: ready.length > 0,
      demoLanguages: ready,
      copy: readCopy(row.copy),
    };
  }

  async startSession(key: string, dto: StartDemoSessionDto) {
    const row = await this.enabledProfile(key);
    const scenario = row.scenario;
    if (!scenario) throw new ConflictException(UNAVAILABLE);
    const voices = readVoices(scenario.languageModels);
    const voice = voices[dto.language];
    if (!voice?.sttModelId || !voice.ttsModelId || !voice.llmModelId) {
      throw new ConflictException('The live voice demo is not configured for this language.');
    }
    const allowedModelIds = [...new Set(Object.values(voices).flatMap((item) => [item.sttModelId, item.ttsModelId, item.llmModelId].filter((id): id is string => Boolean(id))))];
    const models = await this.publicModels(allowedModelIds);
    const required = [voice.sttModelId, voice.ttsModelId, voice.llmModelId];
    const enabled = new Map([...models.speechModels, ...models.sttModels, ...models.llmModels].map((model) => [model.id, model.enabled]));
    if (required.some((id) => enabled.get(id) !== true)) throw new ConflictException(UNAVAILABLE);

    const token = `demo_${randomBytes(32).toString('base64url')}`;
    await this.prisma.demoSession.create({
      data: {
        profileId: row.id,
        scenarioId: scenario.id,
        tokenHash: hashToken(token),
        allowedModelIds,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    });
    return {
      token,
      scenarioId: scenario.id,
      graph: scenario.graph,
      languages: scenario.languages,
      languageModels: voices,
      realtimeModel: readRealtimeModel(scenario.realtimeModel),
      voiceMode: readVoiceMode(scenario.voiceMode),
      voicePrompt: readVoicePrompt(scenario.voicePrompt),
      models,
    };
  }

  private async enabledProfile(key: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(key)) throw new NotFoundException(PROFILE_UNAVAILABLE);
    const row = await this.prisma.demoProfile.findUnique({
      where: { key },
      select: { ...profileSelect, scenario: { select: { ...profileSelect.scenario.select, graph: true } } },
    });
    if (!row?.enabled) throw new NotFoundException(PROFILE_UNAVAILABLE);
    return row;
  }

  private async publicModels(ids: string[]) {
    const [speechModels, sttModels, llmModels] = await Promise.all([
      this.prisma.textToSpeechModel.findMany({ where: { id: { in: ids } }, select: { id: true, enabled: true, name: true, provider: true } }),
      this.prisma.speechToTextModel.findMany({ where: { id: { in: ids } }, select: { id: true, enabled: true, name: true, provider: true } }),
      this.prisma.llmModel.findMany({ where: { id: { in: ids } }, select: { id: true, enabled: true, name: true, provider: true } }),
    ]);
    return { speechModels, sttModels, llmModels };
  }

  private async toData(dto: SaveDemoProfileDto): Promise<Prisma.DemoProfileUncheckedCreateInput> {
    if (dto.scenarioId) {
      const scenario = await this.prisma.scenario.findUnique({ where: { id: dto.scenarioId }, select: { id: true } });
      if (!scenario) throw new BadRequestException('Choose a scenario that exists.');
    }
    return {
      key: dto.key,
      displayName: dto.displayName,
      scenarioId: dto.scenarioId ?? null,
      defaultLanguage: dto.defaultLanguage,
      enabled: dto.enabled,
      accent: dto.accent ?? null,
      logoUrl: dto.logoUrl ?? null,
      copy: copiesOf(dto.copies) as unknown as Prisma.InputJsonValue,
    };
  }

  private presentAdmin(row: ProfileRow) {
    const { scenario, ...profile } = row;
    return {
      ...profile,
      demoAvailable: readyLanguages(scenario).length > 0,
      scenario: scenario ? { id: scenario.id, name: scenario.name } : null,
      copy: readCopy(profile.copy),
    };
  }

  private async requireProfile(id: string) {
    const row = await this.prisma.demoProfile.findUnique({ where: { id }, select: { id: true } });
    if (!row) throw new NotFoundException('Demo profile not found.');
  }

  private rethrowKnown(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('That demo link is already in use.');
    }
    throw error;
  }
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function copiesOf(copies: SaveDemoProfileDto['copies']): Record<DemoLanguage, ProfileCopy> {
  const next = {} as Record<DemoLanguage, ProfileCopy>;
  for (const copy of copies) {
    if (next[copy.language]) throw new BadRequestException('Each language can be entered once.');
    next[copy.language] = { heading: copy.heading, introduction: copy.introduction, starters: copy.starters };
  }
  for (const language of DEMO_LANGUAGES) {
    if (!next[language]) throw new BadRequestException('Add Armenian, English, and Russian text.');
  }
  return next;
}

function readCopy(value: Prisma.JsonValue): Record<DemoLanguage, ProfileCopy> {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const copy = {} as Record<DemoLanguage, ProfileCopy>;
  for (const language of DEMO_LANGUAGES) {
    const item = source[language];
    const record = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    copy[language] = {
      heading: typeof record.heading === 'string' ? record.heading : '',
      introduction: typeof record.introduction === 'string' ? record.introduction : '',
      starters: Array.isArray(record.starters) ? record.starters.filter((line): line is string => typeof line === 'string' && line.trim().length > 0) : [],
    };
  }
  return copy;
}

function readVoices(value: Prisma.JsonValue): Record<string, VoiceIds> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const voices: Record<string, VoiceIds> = {};
  for (const [language, voice] of Object.entries(value)) {
    if (!voice || typeof voice !== 'object' || Array.isArray(voice)) continue;
    const record = voice as Record<string, unknown>;
    voices[language] = {
      sttModelId: typeof record.sttModelId === 'string' ? record.sttModelId : null,
      ttsModelId: typeof record.ttsModelId === 'string' ? record.ttsModelId : null,
      llmModelId: typeof record.llmModelId === 'string' ? record.llmModelId : null,
    };
  }
  return voices;
}

function readyLanguages(scenario: { languages: string[]; languageModels: Prisma.JsonValue } | null) {
  if (!scenario) return [];
  const voices = readVoices(scenario.languageModels);
  return scenario.languages.filter((language) => {
    const voice = voices[language];
    return Boolean(voice?.sttModelId && voice.ttsModelId && voice.llmModelId);
  });
}
