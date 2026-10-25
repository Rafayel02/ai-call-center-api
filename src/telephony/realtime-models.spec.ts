import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_REALTIME_MODEL, readRealtimeModel } from './realtime-models';

test('an unknown live voice model falls back to the Armenian-listed default', () => {
  assert.equal(readRealtimeModel('gpt-realtime-2.1'), 'gpt-realtime-2.1');
  assert.equal(readRealtimeModel('gpt-realtime-1.5'), 'gpt-realtime-1.5');
  assert.equal(readRealtimeModel('gpt-realtime-2'), 'gpt-realtime-2');
  assert.equal(readRealtimeModel('gemini-3.8-live'), 'gemini-3.8-live');
  assert.equal(readRealtimeModel('gemini-2.5-flash-native-audio-preview-12-2025'), 'gemini-2.5-flash-native-audio-preview-12-2025');
  assert.equal(readRealtimeModel('gpt-4o'), DEFAULT_REALTIME_MODEL);
  assert.equal(readRealtimeModel(undefined), DEFAULT_REALTIME_MODEL);
});
