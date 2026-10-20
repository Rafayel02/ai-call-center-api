const ELEVENLABS_MODELS: Record<string, string[]> = {
  v3: ['eleven_v3'],
  'v3 Conversational': ['eleven_v3_conversational'],
  'v2 Multilingual': ['eleven_multilingual_v2'],
  'Flash / Turbo': ['eleven_flash_v2_5', 'eleven_flash_v2', 'eleven_turbo_v2_5', 'eleven_turbo_v2'],
  'Scribe v2 Medical': ['scribe_v2_medical'],
  'Scribe v2': ['scribe_v2'],
};

const CARD_LABELS = new Set(['Text to Speech', 'Speech to Text', 'Audio Processing', 'Music Generation', 'New']);

export function readOpenAiPrices(markdown: string): Record<string, string> {
  const start = markdown.indexOf('### Standard pricing data');
  if (start < 0) return {};
  const next = markdown.indexOf('\n### ', start + '### Standard pricing data'.length);
  const section = markdown.slice(start, next < 0 ? undefined : next);
  const prices: Record<string, string> = {};
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
    prices[model] = output.startsWith('$') ? `${input} in / ${output} out per 1M tokens` : `${input} in per 1M tokens`;
  }
  return prices;
}

export function readElevenLabsPrices(page: string): Record<string, string> {
  const fromMarkdown = readElevenLabsMarkdown(page);
  return Object.keys(fromMarkdown).length > 0 ? fromMarkdown : readElevenLabsHtml(page);
}

function readElevenLabsMarkdown(markdown: string): Record<string, string> {
  const prices: Record<string, string> = {};
  const pattern = /^### ([^\n]+)\n(?:(?!^### )[^\n]*\n){0,12}?\$([0-9]+(?:\.[0-9]+)?)\n+Price per ([^\n]+)/gm;
  for (const match of markdown.matchAll(pattern)) {
    assignElevenLabs(prices, match[1].trim(), match[2], match[3].trim());
  }
  return prices;
}

function readElevenLabsHtml(html: string): Record<string, string> {
  const prices: Record<string, string> = {};
  const pattern = /tw-type-2xl">\$([0-9]+(?:\.[0-9]+)?)[\s\S]{0,240}?tw-type-xs">([^<]+)</g;
  for (const match of html.matchAll(pattern)) {
    const unit = match[2]?.trim() ?? '';
    if (!/^Price per /i.test(unit)) continue;
    const name = cardName(html.slice(Math.max(0, (match.index ?? 0) - 900), match.index));
    assignElevenLabs(prices, name, match[1], unit.replace(/^Price\s+/i, ''));
  }
  return prices;
}

function assignElevenLabs(prices: Record<string, string>, name: string, amount: string | undefined, unit: string) {
  const modelIds = ELEVENLABS_MODELS[name];
  if (!modelIds || !amount || !unit) return;
  const phrase = /^per\b/i.test(unit) ? unit : `per ${unit}`;
  const label = `$${amount} ${phrase}`;
  for (const modelId of modelIds) prices[modelId] = label;
}

export function readHiSpeechPrice(html: string): string | null {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const credits = text.match(/transcription\D{0,40}(\d+)\s+credits?\s+per\s+second/i) ?? text.match(/(\d+)\s+credits?\s+per\s+second of audio/i);
  const usage = !credits ? null : credits[1] === '1' ? '1 credit per second' : `${credits[1]} credits per second`;
  const dollars = text.match(/\$([0-9]+(?:\.[0-9]+)?)\s*(?:\([^)]*\))?\s*per hour of transcription/i);
  if (dollars && usage) return `$${dollars[1]} per hour · ${usage}`;
  if (dollars) return `$${dollars[1]} per hour`;
  return usage;
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
