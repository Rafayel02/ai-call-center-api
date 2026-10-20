import assert from 'node:assert/strict';
import test from 'node:test';
import { PriceCatalog, highlightPrices, priceExecution } from './execution-price';

const catalog: PriceCatalog = {
  openai: {
    'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  },
  elevenlabs: {
    eleven_v3: { usd: 0.08, unit: '1k_characters' },
    scribe_v2: { usd: 0.22, unit: 'hour' },
  },
  hispeech: { usdPerHour: 1.89, creditsPerSecond: 1 },
};

test('an execution price is the sum of its speech, transcription, and model calls', () => {
  const quote = priceExecution(
    [
      { id: 'llm', type: 'llm.completed', payload: { provider: 'OPENAI', providerModel: 'gpt-4o-mini', usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 } } },
      { id: 'tts', type: 'tts.ready', payload: { provider: 'ELEVENLABS', providerModel: 'eleven_v3', text: 'a'.repeat(1000) } },
      { id: 'cached', type: 'tts.ready', payload: { provider: 'ELEVENLABS', providerModel: 'eleven_v3', text: 'cached line', cached: true } },
      { id: 'stt', type: 'stt.completed', payload: { provider: 'ELEVENLABS', providerModel: 'scribe_v2', utteranceDurationMs: 3_600_000 } },
      { id: 'hi', type: 'stt.completed', payload: { provider: 'HISPEECH', providerModel: 'model-23012026', utteranceDurationMs: 3_600_000 } },
      { id: 'node', type: 'node.entered', payload: {} },
    ],
    catalog,
  );
  assert.equal(quote.persist, true);
  assert.equal(quote.complete, true);
  assert.equal(quote.usd, 2.94);
  assert.equal(quote.parts.model, 0.75);
  assert.equal(quote.parts.textToSpeech, 0.08);
  assert.equal(quote.parts.speechToText, 2.11);
  assert.deepEqual(
    quote.parts.lines.map((line) => line.eventId),
    ['llm', 'tts', 'cached', 'stt', 'hi'],
  );
});

test('a run with no provider calls costs nothing', () => {
  const quote = priceExecution([{ id: 'end', type: 'execution.ended', payload: {} }], catalog);
  assert.equal(quote.usd, 0);
  assert.equal(quote.complete, true);
  assert.equal(quote.persist, true);
  assert.deepEqual(quote.parts.lines, []);
});

test('a model without a published price keeps the known total and is marked incomplete', () => {
  const quote = priceExecution(
    [
      { id: 'tts', type: 'tts.ready', payload: { provider: 'ELEVENLABS', providerModel: 'eleven_v3', text: 'hi' } },
      { id: 'stt', type: 'stt.failed', payload: { provider: 'ELEVENLABS', providerModel: 'scribe_v1', utteranceDurationMs: 1000 } },
    ],
    catalog,
  );
  assert.equal(quote.persist, true);
  assert.equal(quote.complete, false);
  assert.equal(quote.usd, 0.00016);
});

test('a missing price list is not stored as zero', () => {
  const quote = priceExecution([{ id: 'llm', type: 'llm.completed', payload: { provider: 'OPENAI', providerModel: 'gpt-4o-mini', usage: { promptTokens: 10, completionTokens: 10 } } }], {
    openai: null,
    elevenlabs: catalog.elevenlabs,
    hispeech: catalog.hispeech,
  });
  assert.equal(quote.persist, false);
});

test('a reply highlight carries the model call that produced it, and a delay does not', () => {
  const parts = {
    speechToText: 0.22,
    textToSpeech: 0.08,
    model: 0.75,
    lines: [
      { eventId: 'stt', component: 'speechToText' as const, usd: 0.22 },
      { eventId: 'llm', component: 'model' as const, usd: 0.75 },
      { eventId: 'delay-ready', component: 'textToSpeech' as const, usd: 0.02 },
      { eventId: 'reply-ready', component: 'textToSpeech' as const, usd: 0.06 },
    ],
  };
  const prices = highlightPrices(
    [
      { eventId: 'stt', speaker: 'caller', kind: null, startMs: 0 },
      { eventId: 'delay-played', speaker: 'agent', kind: 'delay', startMs: 1200 },
      { eventId: 'reply-played', speaker: 'agent', kind: 'reply', startMs: 2400 },
    ],
    [
      { id: 'stt', clientSeq: 1, offsetMs: 1000, type: 'stt.completed', payload: {} },
      { id: 'delay-ready', clientSeq: 2, offsetMs: 1100, type: 'tts.ready', payload: { text: 'One moment' } },
      { id: 'delay-played', clientSeq: 3, offsetMs: 1200, type: 'tts.played', payload: { text: 'One moment', kind: 'delay', audioEventSeq: 2 } },
      { id: 'llm', clientSeq: 4, offsetMs: 1800, type: 'llm.completed', payload: {} },
      { id: 'reply-ready', clientSeq: 5, offsetMs: 2000, type: 'tts.ready', payload: { text: 'We are open' } },
      { id: 'reply-played', clientSeq: 6, offsetMs: 2400, type: 'tts.played', payload: { text: 'We are open', kind: 'reply', audioEventSeq: 5 } },
    ],
    parts,
  );
  assert.deepEqual(prices.stt, [{ component: 'speechToText', usd: 0.22 }]);
  assert.deepEqual(prices['delay-played'], [{ component: 'textToSpeech', usd: 0.02 }]);
  assert.deepEqual(prices['reply-played'], [
    { component: 'model', usd: 0.75 },
    { component: 'textToSpeech', usd: 0.06 },
  ]);
});
