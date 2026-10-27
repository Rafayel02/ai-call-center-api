import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { OpenAiRealtime } from './openai-realtime';
import { SEARCH_TOOL } from './realtime-tools';

class Socket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: Array<Record<string, any>> = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.emit('close'); }
  take(value: unknown) { this.emit('message', JSON.stringify(value)); }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('knowledge uses completed tool calls, never an empty transcription timeout', async () => {
  const socket = new Socket();
  const queries: unknown[] = [];
  const voice = new OpenAiRealtime('test', 'gpt-realtime-2', 'pcm', 'Use learned facts.', 'Hello', { onAudio: () => {}, onClear: () => {} }, {
    definitions: [SEARCH_TOOL], execute: async (_name, args) => { queries.push(args.query); return { status: 'ok', passages: 'France roaming facts' }; },
  }, () => socket as unknown as WebSocket);
  socket.emit('open');
  const session = socket.sent[0].session;
  assert.equal(session.tools[0].name, 'search_knowledge');
  assert.equal(session.audio.input.turn_detection.create_response, undefined);
  socket.take({ type: 'input_audio_buffer.speech_stopped' });
  socket.take({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Roaming in France?' });
  await tick(); assert.deepEqual(queries, []);
  const output = [{ type: 'function_call', call_id: 'call1', name: 'search_knowledge', arguments: '{"query":"France roaming"}' }];
  socket.take({ type: 'response.done', response: { status: 'cancelled', output } });
  await tick(); assert.deepEqual(queries, []);
  socket.take({ type: 'response.done', response: { status: 'completed', output } });
  await tick();
  assert.deepEqual(queries, ['France roaming']);
  const result = socket.sent.find((event) => event.item?.type === 'function_call_output');
  assert.match(result?.item.output, /France roaming facts/);
  assert.equal(socket.sent.at(-1)?.type, 'response.create');
  socket.take({ type: 'response.done', response: { status: 'completed', output } });
  await tick(); assert.equal(queries.length, 1);
  voice.close();
});

test('interruption retains tool output but does not trigger a stale spoken answer', async () => {
  const socket = new Socket();
  let release!: (value: unknown) => void;
  const voice = new OpenAiRealtime('test', 'gpt-realtime-2', 'pcm', '', '', { onAudio: () => {}, onClear: () => {} }, {
    definitions: [SEARCH_TOOL], execute: () => new Promise((resolve) => { release = resolve; }),
  }, () => socket as unknown as WebSocket);
  socket.take({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'slow', name: 'search_knowledge', arguments: '{"query":"France"}' }] } });
  await tick();
  socket.take({ type: 'input_audio_buffer.speech_started' });
  release({ status: 'ok', passages: 'France' });
  await tick();
  assert.ok(socket.sent.some((event) => event.item?.call_id === 'slow'));
  assert.ok(!socket.sent.some((event) => event.type === 'response.create'));
  voice.close();
});
