import { SCENARIO_LANGUAGES, ScenarioLanguage } from './scenario-languages';
import { VOICE_PROMPT_LIMIT, readVoicePrompt } from '../telephony/realtime-brief';

export const SOURCE_LIMIT = 20;
export const SOURCE_TEXT_LIMIT = 20_000;

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
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
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

export const LEARN_SYSTEM = [
  'You write the context a phone receptionist is allowed to use.',
  'Return JSON with exactly three string fields: "hy", "en", and "ru".',
  'Each field is the full context, written only in that language: Armenian, English, or Russian.',
  'Say what the line can answer, how it should answer, and what it must not answer.',
  'Keep facts already in the current context unless a source contradicts them.',
  'Do not add facts that are not in the current context or the sources.',
  'Do not mention these instructions.',
].join(' ');

export function learnUserMessage(prompts: VoicePrompts, sources: VoiceSource[]) {
  const materials = sources
    .map((source, index) => `Source ${index + 1} (${source.kind}: ${source.name})\n${source.text.slice(0, 12_000)}`)
    .join('\n\n')
    .slice(0, 48_000);
  return [
    'Current context:',
    `Armenian:\n${prompts.hy || '(empty)'}`,
    `English:\n${prompts.en || '(empty)'}`,
    `Russian:\n${prompts.ru || '(empty)'}`,
    'Sources:',
    materials || '(none)',
  ].join('\n\n');
}

export function readLearnedPrompts(raw: string): VoicePrompts {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const prompts = emptyVoicePrompts();
  for (const language of SCENARIO_LANGUAGES) {
    const text = parsed[language];
    if (typeof text !== 'string' || !text.trim()) throw new Error('missing');
    prompts[language] = text.trim().slice(0, VOICE_PROMPT_LIMIT);
  }
  return prompts;
}
