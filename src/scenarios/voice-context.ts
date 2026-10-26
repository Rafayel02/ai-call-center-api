import { LANGUAGE_NAME, SCENARIO_LANGUAGES, ScenarioLanguage } from './scenario-languages';
import { VOICE_PROMPT_LIMIT, readVoicePrompt } from '../telephony/realtime-brief';

export const SOURCE_LIMIT = 40;
export const SOURCE_TEXT_LIMIT = 40_000;

export type VoicePrompts = Record<ScenarioLanguage, string>;

export interface VoiceSource {
  id: string;
  kind: 'link' | 'file';
  name: string;
  url: string | null;
  text: string;
  createdAt: string;
}

export interface PublicVoiceSource {
  id: string;
  kind: 'link' | 'file';
  name: string;
  url: string | null;
  createdAt: string;
  characters: number;
}

export function emptyVoicePrompts(): VoicePrompts {
  return { hy: '', en: '', ru: '' };
}

/** The stored Armenian prompt is the old single field, until each language has its own. */
export function readVoicePrompts(value: unknown, legacy?: unknown): VoicePrompts {
  const prompts = emptyVoicePrompts();
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const language of SCENARIO_LANGUAGES) {
      const text = (value as Record<string, unknown>)[language];
      if (typeof text === 'string') prompts[language] = text.trim().slice(0, VOICE_PROMPT_LIMIT);
    }
  }
  const previous = readVoicePrompt(legacy);
  if (previous && !prompts.hy && !prompts.en && !prompts.ru) prompts.hy = previous;
  return prompts;
}

export function voicePromptFor(prompts: VoicePrompts, language: ScenarioLanguage) {
  return prompts[language] ?? '';
}

export function readVoiceSources(value: unknown): VoiceSource[] {
  if (!Array.isArray(value)) return [];
  const sources: VoiceSource[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if ((row.kind !== 'link' && row.kind !== 'file') || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.text !== 'string') continue;
    sources.push({
      id: row.id,
      kind: row.kind,
      name: row.name.trim().slice(0, 200) || 'Untitled',
      url: typeof row.url === 'string' && row.url.trim() ? row.url.trim().slice(0, 2000) : null,
      text: row.text.trim().slice(0, SOURCE_TEXT_LIMIT),
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date(0).toISOString(),
    });
  }
  return sources.slice(0, SOURCE_LIMIT);
}

export function publicVoiceSource(source: VoiceSource): PublicVoiceSource {
  return { id: source.id, kind: source.kind, name: source.name, url: source.url, createdAt: source.createdAt, characters: source.text.length };
}

export function pageText(html: string) {
  const withoutChrome = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  return visibleText(withoutChrome);
}

function visibleText(html: string) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code: string) => {
      const value = Number(code);
      return value > 0 && value < 0x110000 ? String.fromCodePoint(value) : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function readNotes(raw: string) {
  const text = flattenJson(JSON.parse(raw));
  if (!text.trim()) throw new Error('missing');
  return text.trim().slice(0, 14_000);
}

function flattenJson(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenJson(item, depth + 1)).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object' || depth > 4) return '';
  const entries = Object.entries(value as Record<string, unknown>);
  return entries
    .map(([key, item]) => {
      const text = flattenJson(item, depth + 1);
      if (!text) return '';
      if (typeof item === 'string' && depth === 0 && entries.length === 1) return text;
      if (Array.isArray(item) && item.every((entry) => typeof entry === 'string')) return text;
      return `${key}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

export function readLearnedPrompt(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const text = parsed.en ?? parsed.prompt ?? parsed.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('missing');
  return text.trim().slice(0, VOICE_PROMPT_LIMIT);
}

export function translateSystem(language: ScenarioLanguage) {
  return [
    `Translate the receptionist context into ${LANGUAGE_NAME[language]}.`,
    'Return JSON with one string field, "text".',
    `Write only in ${LANGUAGE_NAME[language]}.`,
    'Keep every section, plan, price, condition, address, and step. Do not shorten the reference into a welcome.',
    'Do not add facts. Do not mention these instructions.',
  ].join(' ');
}

export function readTranslatedPrompt(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const text = parsed.text ?? parsed.prompt;
  if (typeof text !== 'string' || !text.trim()) throw new Error('missing');
  return text.trim().slice(0, VOICE_PROMPT_LIMIT);
}
