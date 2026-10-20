import assert from 'node:assert/strict';
import test from 'node:test';
import { PriceCatalog, priceExecution } from './execution-price';

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
      { type: 'llm.completed', payload: { provider: 'OPENAI', providerModel: 'gpt-4o-mini', usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 } } },
      { type: 'tts.ready', payload: { provider: 'ELEVENLABS', providerModel: 'eleven_v3', text: 'a'.repeat(1000) } },
      { type: 'tts.ready', payload: { provider: 'ELEVENLABS', providerModel: 'eleven_v3', text: 'cached line', cached: true } },
      { type: 'stt.completed', payload: { provider: 'ELEVENLABS', providerModel: 'scribe_v2', utteranceDurationMs: 3_600_000 } },
      { type: 'stt.completed', payload: { provider: 'HISPEECH', providerModel: 'model-23012026', utteranceDurationMs: 3_600_000 } },
      { type: 'node.entered', payload: {} },
    ],
    catalog,
  );
  assert.equal(quote.persist, true);
  assert.equal(quote.complete, true);
  assert.equal(quote.usd, 2.94);
});

test('a run with no provider calls costs nothing', () => {
  const quote = priceExecution([{ type: 'execution.ended', payload: {} }], catalog);
  assert.deepEqual(quote, { usd: 0, complete: true, persist: true });
});

test('a model without a published price keeps the known total and is marked incomplete', () => {
  const quote = priceExecution(
    [
      { type: 'tts.ready', payload: { provider: 'ELEVENLABS', providerModel: 'eleven_v3', text: 'hi' } },
      { type: 'stt.failed', payload: { provider: 'ELEVENLABS', providerModel: 'scribe_v1', utteranceDurationMs: 1000 } },
    ],
    catalog,
  );
  assert.equal(quote.persist, true);
  assert.equal(quote.complete, false);
  assert.equal(quote.usd, 0.00016);
});

test('a missing price list is not stored as zero', () => {
  const quote = priceExecution([{ type: 'llm.completed', payload: { provider: 'OPENAI', providerModel: 'gpt-4o-mini', usage: { promptTokens: 10, completionTokens: 10 } } }], {
    openai: null,
    elevenlabs: catalog.elevenlabs,
    hispeech: catalog.hispeech,
  });
  assert.equal(quote.persist, false);
});
