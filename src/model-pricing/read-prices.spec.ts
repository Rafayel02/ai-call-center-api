import assert from 'node:assert/strict';
import test from 'node:test';
import { readElevenLabsPrices, readHiSpeechPrice, readOpenAiPrices } from './read-prices';

const OPENAI = `
### Standard pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output |
| --- | --- | --- | --- | --- |
| gpt-4.1 | $2.00 | $0.50 | - | $8.00 |
| gpt-4o-mini | $0.15 | $0.075 | - | $0.60 |

### Batch pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output |
| gpt-4.1 | $1.00 | - | - | $4.00 |
`;

test('OpenAI prices come from the standard table', () => {
  const prices = readOpenAiPrices(OPENAI);
  assert.equal(prices['gpt-4.1'], '$2.00 in / $8.00 out per 1M tokens');
  assert.equal(prices['gpt-4o-mini'], '$0.15 in / $0.60 out per 1M tokens');
});

const ELEVENLABS_MARKDOWN = `
### v3 Conversational

Text to Speech

$0.04

Price per 1K characters

### v3

Text to Speech

$0.08

Price per 1K characters

### Scribe v2 Medical

Speech to Text

$0.48

Price per hour

### Scribe v2

Speech to Text

$0.22

Price per hour

### Flash / Turbo

Text to Speech

$0.04

Price per 1K characters
`;

test('ElevenLabs cards keep Scribe v2 apart from Scribe v2 Medical', () => {
  const prices = readElevenLabsPrices(ELEVENLABS_MARKDOWN);
  assert.equal(prices.eleven_v3, '$0.08 per 1K characters');
  assert.equal(prices.eleven_v3_conversational, '$0.04 per 1K characters');
  assert.equal(prices.scribe_v2, '$0.22 per hour');
  assert.equal(prices.scribe_v2_medical, '$0.48 per hour');
  assert.equal(prices.eleven_flash_v2_5, '$0.04 per 1K characters');
  assert.equal(prices.scribe_v1, undefined);
});

test('ElevenLabs HTML cards still parse when the markdown page is unavailable', () => {
  const html = `
    <div class="tw-z-10">v3 Text to Speech <span class="tw-type-2xl">$0.08</span></div><p class="tw-type-xs">Price per 1K characters</p>
  `;
  assert.equal(readElevenLabsPrices(html).eleven_v3, '$0.08 per 1K characters');
});

test('HiSpeech price is the published credit price', () => {
  assert.equal(
    readHiSpeechPrice(
      'Subtitle files — 4 credits per second. Transcription — 1 credit per second of audio. Top up at $1.89 (690 ֏) per hour of transcription — 3,600 credits per block.',
    ),
    '$1.89 per hour · 1 credit per second',
  );
  assert.equal(readHiSpeechPrice('<li>Transcription — 1 credit per second of audio.</li>'), '1 credit per second');
  assert.equal(readHiSpeechPrice('<p>No rate published.</p>'), null);
});
