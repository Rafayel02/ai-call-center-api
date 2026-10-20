export const SCENARIO_LANGUAGES = ['hy', 'en', 'ru'] as const;

export type ScenarioLanguage = (typeof SCENARIO_LANGUAGES)[number];

export const LANGUAGE_NAME: Record<ScenarioLanguage, string> = {
  hy: 'Armenian',
  en: 'English',
  ru: 'Russian',
};

export const LANGUAGE_FLAG: Record<ScenarioLanguage, string> = {
  hy: '🇦🇲',
  en: '🇬🇧',
  ru: '🇷🇺',
};

export const SPOKEN_NAME: Record<ScenarioLanguage, string> = {
  hy: 'Հայերեն',
  en: 'English',
  ru: 'Русский',
};

export const DEFAULT_CLOSING: Record<ScenarioLanguage, string> = {
  hy: 'Ուրիշ հարցեր ունե՞ք:',
  en: 'Do you have other questions?',
  ru: 'У вас есть другие вопросы?',
};

export const DEFAULT_FILLER: Record<ScenarioLanguage, string> = {
  hy: 'Մի րոպե, կստուգեմ:',
  en: "Just a moment, I'll check.",
  ru: 'Минуту, я проверю.',
};

export function isScenarioLanguage(value: string): value is ScenarioLanguage {
  return (SCENARIO_LANGUAGES as readonly string[]).includes(value);
}

export function detectScript(sample: string): ScenarioLanguage {
  const armenian = sample.match(/[\u0530-\u058F]/g)?.length ?? 0;
  const cyrillic = sample.match(/[\u0400-\u04FF]/g)?.length ?? 0;
  const latin = sample.match(/[A-Za-z]/g)?.length ?? 0;
  if (armenian >= cyrillic && armenian >= latin && armenian > 0) return 'hy';
  if (cyrillic >= latin && cyrillic > 0) return 'ru';
  return 'en';
}

export function spokenLine(data: { text?: string; texts?: Partial<Record<ScenarioLanguage, string>> }, language: ScenarioLanguage) {
  return (data.texts?.[language] ?? data.text ?? '').trim();
}

export function delayLines(data: { fillers?: string[]; fillerTexts?: Partial<Record<ScenarioLanguage, string[]>> }, language: ScenarioLanguage) {
  const lines = data.fillerTexts?.[language] ?? data.fillers ?? [];
  return lines.map((line) => line.trim()).filter(Boolean);
}

interface GraphNode {
  type?: string;
  data?: Record<string, unknown>;
}

function nodesOf(graph: unknown): GraphNode[] {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return [];
  const nodes = (graph as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes.filter((node): node is GraphNode => !!node && typeof node === 'object') : [];
}

function sourceLines(data: Record<string, unknown>, language: ScenarioLanguage, many: boolean): string[] {
  if (many) {
    const byLanguage = data.fillerTexts;
    if (byLanguage && typeof byLanguage === 'object' && !Array.isArray(byLanguage)) {
      const lines = (byLanguage as Record<string, unknown>)[language];
      if (Array.isArray(lines)) return lines.filter((line): line is string => typeof line === 'string');
    }
    return Array.isArray(data.fillers) ? data.fillers.filter((line): line is string => typeof line === 'string') : [];
  }
  const texts = data.texts;
  if (texts && typeof texts === 'object' && !Array.isArray(texts)) {
    const line = (texts as Record<string, unknown>)[language];
    if (typeof line === 'string') return [line];
  }
  return [typeof data.text === 'string' ? data.text : ''];
}

export interface SpokenSlot {
  node: number;
  field: 'texts' | 'fillerTexts';
  lines: string[];
}

export function spokenSlots(graph: unknown, source: ScenarioLanguage): SpokenSlot[] {
  return nodesOf(graph).flatMap((node, nodeIndex): SpokenSlot[] => {
    const data = node.data ?? {};
    if (node.type === 'tts' || node.type === 'closing') return [{ node: nodeIndex, field: 'texts' as const, lines: sourceLines(data, source, false) }];
    if (node.type === 'loop') return [{ node: nodeIndex, field: 'fillerTexts' as const, lines: sourceLines(data, source, true) }];
    return [];
  });
}

export function spokenSample(graph: unknown): string {
  return nodesOf(graph)
    .flatMap((node) => {
      const data = node.data ?? {};
      const lines: string[] = [];
      if (typeof data.text === 'string') lines.push(data.text);
      if (Array.isArray(data.fillers)) lines.push(...data.fillers.filter((line): line is string => typeof line === 'string'));
      for (const field of [data.texts, data.fillerTexts]) {
        if (!field || typeof field !== 'object' || Array.isArray(field)) continue;
        for (const value of Object.values(field)) {
          if (typeof value === 'string') lines.push(value);
          if (Array.isArray(value)) lines.push(...value.filter((line): line is string => typeof line === 'string'));
        }
      }
      return lines;
    })
    .join('\n')
    .slice(0, 4000);
}

export function stampLanguage(graph: unknown, language: ScenarioLanguage): unknown {
  const copy = structuredClone(graph) as { nodes?: GraphNode[] };
  for (const node of nodesOf(copy)) {
    const data = (node.data ??= {});
    if (node.type === 'tts' || node.type === 'closing') {
      if (!data.texts || typeof data.texts !== 'object' || Array.isArray(data.texts)) {
        data.texts = { [language]: typeof data.text === 'string' ? data.text : '' };
      }
    }
    if (node.type === 'loop' && (!data.fillerTexts || typeof data.fillerTexts !== 'object' || Array.isArray(data.fillerTexts))) {
      data.fillerTexts = { [language]: Array.isArray(data.fillers) ? data.fillers.filter((line): line is string => typeof line === 'string') : [] };
    }
  }
  return copy;
}

export function applyTranslations(graph: unknown, language: ScenarioLanguage, slots: SpokenSlot[], lines: string[]): unknown {
  const copy = structuredClone(graph) as { nodes?: GraphNode[] };
  const nodes = nodesOf(copy);
  let cursor = 0;
  for (const slot of slots) {
    const taken = lines.slice(cursor, cursor + slot.lines.length);
    cursor += slot.lines.length;
    const data = (nodes[slot.node].data ??= {});
    if (slot.field === 'texts') {
      const texts = data.texts && typeof data.texts === 'object' && !Array.isArray(data.texts) ? { ...(data.texts as Record<string, string>) } : {};
      texts[language] = taken[0] ?? '';
      data.texts = texts;
    } else {
      const fillerTexts = data.fillerTexts && typeof data.fillerTexts === 'object' && !Array.isArray(data.fillerTexts) ? { ...(data.fillerTexts as Record<string, string[]>) } : {};
      fillerTexts[language] = taken;
      data.fillerTexts = fillerTexts;
    }
  }
  return copy;
}

export function matchSpokenLanguage(transcript: string, options: ScenarioLanguage[]): ScenarioLanguage | null {
  const hints: Record<ScenarioLanguage, RegExp> = {
    hy: /հայ|armenia/i,
    en: /english|անգլ|англ/i,
    ru: /рус|russian|ռուս/i,
  };
  const named = options.find((code) => hints[code].test(transcript));
  if (named) return named;
  const script = detectScript(transcript);
  return options.includes(script) ? script : null;
}
