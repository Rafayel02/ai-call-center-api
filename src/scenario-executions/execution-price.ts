import { HiSpeechRate, MeteredRate, TokenRate } from '../model-pricing/read-prices';

const MICRO = 1_000_000;

export interface PriceCatalog {
  openai: Record<string, TokenRate> | null;
  elevenlabs: Record<string, MeteredRate> | null;
  hispeech: HiSpeechRate | null;
}

export type PriceComponent = 'speechToText' | 'textToSpeech' | 'model';

export interface PriceLine {
  eventId: string;
  component: PriceComponent;
  usd: number;
}

export interface PriceParts {
  speechToText: number;
  textToSpeech: number;
  model: number;
  lines: PriceLine[];
}

export interface HighlightPrice {
  component: PriceComponent;
  usd: number;
}

export interface ExecutionQuote {
  usd: number;
  complete: boolean;
  persist: boolean;
  parts: PriceParts;
}

interface Charge {
  micro: number;
  complete: boolean;
  persist: boolean;
  component: PriceComponent | null;
}

export function priceExecution(events: Array<{ id: string; type: string; payload: unknown }>, catalog: PriceCatalog): ExecutionQuote {
  let micro = 0;
  let complete = true;
  let persist = true;
  const partMicro: Record<PriceComponent, number> = { speechToText: 0, textToSpeech: 0, model: 0 };
  const lines: PriceLine[] = [];
  for (const event of events) {
    const charge = chargeFor(event.type, event.payload, catalog);
    if (!charge) continue;
    micro += charge.micro;
    if (!charge.complete) complete = false;
    if (!charge.persist) persist = false;
    if (charge.component && charge.complete) {
      partMicro[charge.component] += charge.micro;
      lines.push({ eventId: event.id, component: charge.component, usd: charge.micro / MICRO });
    }
  }
  return {
    usd: micro / MICRO,
    complete,
    persist,
    parts: {
      speechToText: partMicro.speechToText / MICRO,
      textToSpeech: partMicro.textToSpeech / MICRO,
      model: partMicro.model / MICRO,
      lines,
    },
  };
}

export function highlightPrices(
  segments: Array<{ eventId: string; speaker: 'caller' | 'agent'; kind: 'step' | 'reply' | 'delay' | null; startMs: number }>,
  events: Array<{ id: string; clientSeq: number; offsetMs: number; type: string; payload: unknown }>,
  parts: PriceParts | null,
): Record<string, HighlightPrice[]> {
  const prices: Record<string, HighlightPrice[]> = {};
  if (!parts) return prices;
  const lineByEvent = new Map(parts.lines.map((line) => [line.eventId, line]));
  const eventById = new Map(events.map((event) => [event.id, event]));
  const readyBySeq = new Map(events.filter((event) => event.type === 'tts.ready').map((event) => [event.clientSeq, event]));
  const usedReady = new Set<string>();
  const models = events
    .filter((event) => event.type === 'llm.completed' && lineByEvent.has(event.id))
    .sort((left, right) => left.offsetMs - right.offsetMs || left.clientSeq - right.clientSeq);
  let modelIndex = 0;
  for (const segment of [...segments].sort((left, right) => left.startMs - right.startMs)) {
    const attached: HighlightPrice[] = [];
    if (segment.speaker === 'caller') {
      const line = lineByEvent.get(segment.eventId);
      if (line) attached.push({ component: line.component, usd: line.usd });
    } else {
      const ready = readyFor(eventById.get(segment.eventId), readyBySeq, usedReady);
      const spoken = ready ? lineByEvent.get(ready.id) : undefined;
      if (ready) usedReady.add(ready.id);
      if (segment.kind !== 'delay') {
        while (modelIndex < models.length && models[modelIndex].offsetMs <= segment.startMs) {
          const line = lineByEvent.get(models[modelIndex].id);
          if (line) attached.push({ component: 'model', usd: line.usd });
          modelIndex += 1;
        }
      }
      if (spoken) attached.push({ component: 'textToSpeech', usd: spoken.usd });
    }
    prices[segment.eventId] = attached;
  }
  return prices;
}

export function readPriceParts(value: unknown): PriceParts | null {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!record) return null;
  const speechToText = amount(record.speechToText);
  const textToSpeech = amount(record.textToSpeech);
  const model = amount(record.model);
  if (speechToText == null || textToSpeech == null || model == null || !Array.isArray(record.lines)) return null;
  const lines: PriceLine[] = [];
  for (const item of record.lines) {
    const line = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const usd = line ? amount(line.usd) : null;
    const eventId = line && typeof line.eventId === 'string' ? line.eventId : '';
    const component = line?.component;
    if (!line || usd == null || !eventId || (component !== 'speechToText' && component !== 'textToSpeech' && component !== 'model')) return null;
    lines.push({ eventId, component, usd });
  }
  return { speechToText, textToSpeech, model, lines };
}

function readyFor(
  played: { payload: unknown } | undefined,
  readyBySeq: Map<number, { id: string; payload: unknown }>,
  usedReady: Set<string>,
) {
  if (!played) return null;
  const payload = record(played.payload);
  const seq = amount(payload.audioEventSeq);
  if (seq != null) {
    const ready = readyBySeq.get(seq);
    if (ready && !usedReady.has(ready.id)) return ready;
  }
  const spoken = typeof payload.text === 'string' ? payload.text : null;
  if (spoken == null) return null;
  for (const ready of readyBySeq.values()) {
    if (usedReady.has(ready.id)) continue;
    if (record(ready.payload).text === spoken) return ready;
  }
  return null;
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
  return priced('model', usd);
}

function chargeSpeech(payload: Record<string, unknown>, catalog: PriceCatalog): Charge {
  if (payload.cached === true) return priced('textToSpeech', 0);
  if (payload.provider !== 'ELEVENLABS') return missed(true);
  if (!catalog.elevenlabs) return missed(false);
  const rate = catalog.elevenlabs[text(payload.providerModel)];
  const spoken = typeof payload.text === 'string' ? payload.text : null;
  if (!rate || rate.unit !== '1k_characters' || spoken == null) return missed(true);
  return priced('textToSpeech', rate.usd * (spoken.length / 1000));
}

function chargeTranscription(payload: Record<string, unknown>, catalog: PriceCatalog): Charge {
  const durationMs = amount(payload.utteranceDurationMs);
  if (payload.provider === 'HISPEECH') {
    if (!catalog.hispeech) return missed(false);
    if (catalog.hispeech.usdPerHour == null || durationMs == null) return missed(true);
    return priced('speechToText', catalog.hispeech.usdPerHour * (durationMs / 3_600_000));
  }
  if (payload.provider !== 'ELEVENLABS') return missed(true);
  if (!catalog.elevenlabs) return missed(false);
  const rate = catalog.elevenlabs[text(payload.providerModel)];
  if (!rate || durationMs == null || (rate.unit !== 'hour' && rate.unit !== 'minute')) return missed(true);
  const hours = durationMs / 3_600_000;
  return priced('speechToText', rate.unit === 'hour' ? rate.usd * hours : rate.usd * hours * 60);
}

function priced(component: PriceComponent, usd: number): Charge {
  return { component, micro: Math.round(usd * MICRO), complete: true, persist: true };
}

function missed(persist: boolean): Charge {
  return { component: null, micro: 0, complete: false, persist };
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
