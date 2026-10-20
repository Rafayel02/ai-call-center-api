const ELEVENLABS_MODELS: Record<string, string[]> = {
  v3: ['eleven_v3'],
  'v3 Conversational': ['eleven_v3_conversational'],
  'v2 Multilingual': ['eleven_multilingual_v2'],
  'Flash / Turbo': ['eleven_flash_v2_5', 'eleven_flash_v2', 'eleven_turbo_v2_5', 'eleven_turbo_v2'],
  'Scribe v2 Medical': ['scribe_v2_medical'],
  'Scribe v2': ['scribe_v2'],
};

const CARD_LABELS = new Set(['Text to Speech', 'Speech to Text', 'Audio Processing', 'Music Generation', 'New']);

export interface TokenRate {
  inputPerMillion: number;
  outputPerMillion: number | null;
}

export interface MeteredRate {
  usd: number;
  unit: '1k_characters' | 'hour' | 'minute';
}

export interface HiSpeechRate {
  usdPerHour: number | null;
  creditsPerSecond: number | null;
}

export function readOpenAiPrices(markdown: string): Record<string, string> {
  const prices: Record<string, string> = {};
  for (const row of openAiRows(markdown)) {
    prices[row.model] = row.output.startsWith('$') ? `${row.input} in / ${row.output} out per 1M tokens` : `${row.input} in per 1M tokens`;
  }
  return prices;
}

export function readOpenAiRates(markdown: string): Record<string, TokenRate> {
  const rates: Record<string, TokenRate> = {};
  for (const row of openAiRows(markdown)) {
    const inputPerMillion = dollars(row.input);
    if (inputPerMillion == null) continue;
    rates[row.model] = { inputPerMillion, outputPerMillion: dollars(row.output) };
  }
  return rates;
}

function openAiRows(markdown: string) {
  const start = markdown.indexOf('### Standard pricing data');
  if (start < 0) return [];
  const next = markdown.indexOf('\n### ', start + '### Standard pricing data'.length);
  const section = markdown.slice(start, next < 0 ? undefined : next);
  const rows: Array<{ model: string; input: string; output: string }> = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('| ')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const model = cells[0]?.replace(/\s*\([^)]*\)$/, '').trim() ?? '';
    const input = cells[1] ?? '';
    const output = cells[4] ?? '';
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(model) || !input.startsWith('$')) continue;
    rows.push({ model, input, output });
  }
  return rows;
}

interface ElevenLabsCards {
  labels: Record<string, string>;
  rates: Record<string, MeteredRate>;
}

export function readElevenLabsPrices(page: string): Record<string, string> {
  return readElevenLabs(page).labels;
}

export function readElevenLabsRates(page: string): Record<string, MeteredRate> {
  return readElevenLabs(page).rates;
}

function readElevenLabs(page: string): ElevenLabsCards {
  const markdown = readElevenLabsMarkdown(page);
  return Object.keys(markdown.labels).length > 0 ? markdown : readElevenLabsHtml(page);
}

function readElevenLabsMarkdown(markdown: string): ElevenLabsCards {
  const cards = emptyCards();
  const pattern = /^### ([^\n]+)\n(?:(?!^### )[^\n]*\n){0,12}?\$([0-9]+(?:\.[0-9]+)?)\n+Price per ([^\n]+)/gm;
  for (const match of markdown.matchAll(pattern)) {
    assignElevenLabs(cards, match[1].trim(), match[2], match[3].trim());
  }
  return cards;
}

function readElevenLabsHtml(html: string): ElevenLabsCards {
  const cards = emptyCards();
  const pattern = /tw-type-2xl">\$([0-9]+(?:\.[0-9]+)?)[\s\S]{0,240}?tw-type-xs">([^<]+)</g;
  for (const match of html.matchAll(pattern)) {
    const unit = match[2]?.trim() ?? '';
    if (!/^Price per /i.test(unit)) continue;
    const name = cardName(html.slice(Math.max(0, (match.index ?? 0) - 900), match.index));
    assignElevenLabs(cards, name, match[1], unit.replace(/^Price\s+/i, ''));
  }
  return cards;
}

function emptyCards(): ElevenLabsCards {
  return { labels: {}, rates: {} };
}

function assignElevenLabs(cards: ElevenLabsCards, name: string, amount: string | undefined, unit: string) {
  const modelIds = ELEVENLABS_MODELS[name];
  const usd = amount ? Number(amount) : Number.NaN;
  if (!modelIds || !amount || !unit || !Number.isFinite(usd)) return;
  const phrase = /^per\b/i.test(unit) ? unit : `per ${unit}`;
  const label = `$${amount} ${phrase}`;
  const rate = meteredRate(usd, phrase);
  for (const modelId of modelIds) {
    cards.labels[modelId] = label;
    if (rate) cards.rates[modelId] = rate;
  }
}

function meteredRate(usd: number, unit: string): MeteredRate | null {
  const phrase = unit.toLowerCase();
  if (/1k characters|1,000 characters/.test(phrase)) return { usd, unit: '1k_characters' };
  if (/\bhour\b/.test(phrase)) return { usd, unit: 'hour' };
  if (/\bminute\b/.test(phrase)) return { usd, unit: 'minute' };
  return null;
}

export function readHiSpeechRate(html: string): HiSpeechRate {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const credits = text.match(/transcription\D{0,40}(\d+)\s+credits?\s+per\s+second/i) ?? text.match(/(\d+)\s+credits?\s+per\s+second of audio/i);
  const dollars = text.match(/\$([0-9]+(?:\.[0-9]+)?)\s*(?:\([^)]*\))?\s*per hour of transcription/i);
  return {
    usdPerHour: dollars ? Number(dollars[1]) : null,
    creditsPerSecond: credits ? Number(credits[1]) : null,
  };
}

export function readHiSpeechPrice(html: string): string | null {
  const rate = readHiSpeechRate(html);
  const usage = rate.creditsPerSecond == null ? null : rate.creditsPerSecond === 1 ? '1 credit per second' : `${rate.creditsPerSecond} credits per second`;
  const dollars = rate.usdPerHour == null ? null : `$${rate.usdPerHour}`;
  if (dollars && usage) return `${dollars} per hour · ${usage}`;
  if (dollars) return `${dollars} per hour`;
  return usage;
}

function dollars(cell: string) {
  const match = /^\$([0-9]+(?:\.[0-9]+)?)$/.exec(cell.trim());
  return match ? Number(match[1]) : null;
}

function cardName(before: string) {
  const lines = before
    .replace(/<[^>]*$/g, '')
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((line) => stripCategory(line))
    .filter((line) => line && !line.startsWith('<') && !line.includes('tw-') && !CARD_LABELS.has(line));
  return lines.at(-1) ?? '';
}

function stripCategory(line: string) {
  const cleaned = line.trim();
  for (const suffix of [' Text to Speech', ' Speech to Text', ' Audio Processing', ' Music Generation']) {
    if (cleaned.endsWith(suffix)) return cleaned.slice(0, -suffix.length).trim();
  }
  return cleaned;
}
