import { HiSpeechRate, MeteredRate, TokenRate } from '../model-pricing/read-prices';

const MICRO = 1_000_000;

export interface PriceCatalog {
  openai: Record<string, TokenRate> | null;
  elevenlabs: Record<string, MeteredRate> | null;
  hispeech: HiSpeechRate | null;
}

export interface ExecutionQuote {
  usd: number;
  complete: boolean;
  persist: boolean;
}

interface Charge {
  micro: number;
  complete: boolean;
  persist: boolean;
}

export function priceExecution(events: Array<{ type: string; payload: unknown }>, catalog: PriceCatalog): ExecutionQuote {
  let micro = 0;
  let complete = true;
  let persist = true;
  for (const event of events) {
    const charge = chargeFor(event.type, event.payload, catalog);
    if (!charge) continue;
    micro += charge.micro;
    if (!charge.complete) complete = false;
    if (!charge.persist) persist = false;
  }
  return { usd: micro / MICRO, complete, persist };
}

function chargeFor(type: string, payload: unknown, catalog: PriceCatalog): Charge | null {
  if (type === 'llm.completed') return chargeLlm(record(payload), catalog);
  if (type === 'tts.ready') return chargeSpeech(record(payload), catalog);
  if (type === 'stt.completed' || type === 'stt.failed') return chargeTranscription(record(payload), catalog);
  return null;
}

function chargeLlm(payload: Record<string, unknown>, catalog: PriceCatalog): Charge {
  if (payload.provider !== 'OPENAI') return missed(true);
  if (!catalog.openai) return missed(false);
  const rate = catalog.openai[text(payload.providerModel)];
  const usage = record(payload.usage);
  const prompt = amount(usage.promptTokens);
  const completion = amount(usage.completionTokens);
  if (!rate || rate.outputPerMillion == null || prompt == null || completion == null) return missed(true);
  const usd = (prompt / MICRO) * rate.inputPerMillion + (completion / MICRO) * rate.outputPerMillion;
  return priced(usd);
}

function chargeSpeech(payload: Record<string, unknown>, catalog: PriceCatalog): Charge {
  if (payload.cached === true) return priced(0);
  if (payload.provider !== 'ELEVENLABS') return missed(true);
  if (!catalog.elevenlabs) return missed(false);
  const rate = catalog.elevenlabs[text(payload.providerModel)];
  const spoken = typeof payload.text === 'string' ? payload.text : null;
  if (!rate || rate.unit !== '1k_characters' || spoken == null) return missed(true);
  return priced(rate.usd * (spoken.length / 1000));
}

function chargeTranscription(payload: Record<string, unknown>, catalog: PriceCatalog): Charge {
  const durationMs = amount(payload.utteranceDurationMs);
  if (payload.provider === 'HISPEECH') {
    if (!catalog.hispeech) return missed(false);
    if (catalog.hispeech.usdPerHour == null || durationMs == null) return missed(true);
    return priced(catalog.hispeech.usdPerHour * (durationMs / 3_600_000));
  }
  if (payload.provider !== 'ELEVENLABS') return missed(true);
  if (!catalog.elevenlabs) return missed(false);
  const rate = catalog.elevenlabs[text(payload.providerModel)];
  if (!rate || durationMs == null || (rate.unit !== 'hour' && rate.unit !== 'minute')) return missed(true);
  const hours = durationMs / 3_600_000;
  return priced(rate.unit === 'hour' ? rate.usd * hours : rate.usd * hours * 60);
}

function priced(usd: number): Charge {
  return { micro: Math.round(usd * MICRO), complete: true, persist: true };
}

function missed(persist: boolean): Charge {
  return { micro: 0, complete: false, persist };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function amount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
