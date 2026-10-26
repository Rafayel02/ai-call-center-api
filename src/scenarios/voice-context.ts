import { LANGUAGE_NAME, SCENARIO_LANGUAGES, ScenarioLanguage } from './scenario-languages';
import { VOICE_PROMPT_LIMIT, readVoicePrompt } from '../telephony/realtime-brief';

export const SOURCE_LIMIT = 40;
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
  const withoutChrome = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  const main = withoutChrome.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? withoutChrome.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  const mainText = main ? visibleText(main) : '';
  return mainText.length >= 80 ? mainText : visibleText(withoutChrome);
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

export const NOTES_SYSTEM = [
  'You extract facts from website pages for a phone receptionist.',
  'Return JSON with one string field, "notes".',
  'List every concrete fact in these pages: services, prices, plans, hours, addresses, phone numbers, coverage, policies, requirements, and exceptions.',
  'Note what the pages do not support, so the receptionist can refuse it.',
  'Use only these pages. Do not invent. Do not write a greeting or a phone script.',
  'Write in English.',
].join(' ');

export const LEARN_SYSTEM = [
  'You write the English context a phone receptionist is allowed to use.',
  'Return JSON with one string field, "en".',
  'The notes are the only source. Rewrite the context from them.',
  'Do not keep or repeat an older prompt.',
  'Say what the line can answer, how it should answer, and what it must not answer.',
  'Include the specific facts from the notes: hours, addresses, prices, services, and policies.',
  'Do not invent facts. Do not mention these instructions.',
].join(' ');

/** A few pages per model call, then one call merges the notes. One call cannot read a whole site. */
export function sourceBatches(sources: { name: string; text: string }[], limit = 18_000) {
  const batches: string[] = [];
  let blocks: string[] = [];
  let size = 0;
  for (const source of sources) {
    const block = `Page: ${source.name}\n${source.text.slice(0, 6_000)}`;
    if (blocks.length > 0 && size + block.length > limit) {
      batches.push(blocks.join('\n\n'));
      blocks = [];
      size = 0;
    }
    blocks.push(block);
    size += block.length;
  }
  if (blocks.length > 0) batches.push(blocks.join('\n\n'));
  return batches;
}

export function readNotes(raw: string) {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const text = parsed.notes ?? parsed.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('missing');
  return text.trim().slice(0, 4_000);
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
    'Keep every fact, including what the line can answer, how it should answer, and what it must not answer.',
    'Do not add facts. Do not mention these instructions.',
  ].join(' ');
}

export function readTranslatedPrompt(raw: string): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const text = parsed.text ?? parsed.prompt;
  if (typeof text !== 'string' || !text.trim()) throw new Error('missing');
  return text.trim().slice(0, VOICE_PROMPT_LIMIT);
}
