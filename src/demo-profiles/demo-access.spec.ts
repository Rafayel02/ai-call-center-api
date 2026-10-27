import assert from 'node:assert/strict';
import test from 'node:test';
import { demoBearer, demoRoute } from './demo-access';

const modelId = '11111111-1111-4111-8111-111111111111';

test('allows only the voice calls a demo session needs', () => {
  assert.deepEqual(demoRoute('POST', `/text-to-speech-models/${modelId}/speak`), { kind: 'model', modelId });
  assert.deepEqual(demoRoute('POST', `/speech-to-text-models/${modelId}/transcribe`), { kind: 'model', modelId });
  assert.deepEqual(demoRoute('POST', `/llm-models/${modelId}/complete`), { kind: 'model', modelId });
  assert.deepEqual(demoRoute('POST', `/llm-models/${modelId}/closing?x=1`), { kind: 'model', modelId });
  assert.deepEqual(demoRoute('POST', '/telephony/talk-token'), { kind: 'talk-token' });
  assert.deepEqual(demoRoute('POST', '/scenario-executions'), { kind: 'create-execution' });
  assert.deepEqual(demoRoute('POST', `/scenario-executions/${modelId}/audio`), { kind: 'execution', executionId: modelId });
});

test('refuses reads and other model operations', () => {
  assert.equal(demoRoute('GET', `/llm-models/${modelId}`), null);
  assert.equal(demoRoute('POST', `/llm-models/${modelId}/route`), null);
  assert.equal(demoRoute('POST', `/text-to-speech-models/${modelId}/test`), null);
  assert.equal(demoRoute('POST', '/scenarios'), null);
  assert.equal(demoBearer('Bearer demo_abc'), 'demo_abc');
  assert.equal(demoBearer('Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig'), null);
});
