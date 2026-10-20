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

export function readElevenLabsPrices(html: string): Record<string, string> {
  const prices: Record<string, string> = {};
  const pattern = /tw-type-2xl">\$([0-9]+(?:\.[0-9]+)?)[\s\S]{0,240}?tw-type-xs">([^<]+)</g;
  for (const match of html.matchAll(pattern)) {
    const amount = match[1];
    const unit = match[2]?.trim() ?? '';
    if (!amount || !/^Price per /i.test(unit)) continue;
    const name = cardName(html.slice(Math.max(0, (match.index ?? 0) - 900), match.index));
    const modelIds = ELEVENLABS_MODELS[name];
    if (!modelIds) continue;
    const label = `$${amount} ${unit.replace(/^Price\s+/i, '')}`;
    for (const modelId of modelIds) prices[modelId] = label;
  }
  return prices;
}

export function readHiSpeechPrice(html: string): string | null {
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  const match = text.match(/transcription\D{0,40}(\d+)\s+credits?\s+per\s+second/i) ?? text.match(/(\d+)\s+credits?\s+per\s+second of audio/i);
  if (!match) return null;
  return match[1] === '1' ? '1 credit per second' : `${match[1]} credits per second`;
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
