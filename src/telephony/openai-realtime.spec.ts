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
  assert.equal(session.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
  assert.equal(session.audio.input.turn_detection.create_response, undefined);
  socket.take({ type: 'input_audio_buffer.speech_stopped' });
  socket.take({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Roaming in France?' });
  await tick(); assert.deepEqual(queries, []);
  const output = [{ type: 'function_call', call_id: 'call1', name: 'search_knowledge', arguments: '{"query":"France roaming"}' }];
  socket.take({ type: 'response.done', response: { status: 'cancelled', output } });
  await tick(); assert.deepEqual(queries, []);
  socket.take({ type: 'response.done', response: { status: 'completed', output } });
  await tick();
  assert.deepEqual(queries, ['Roaming in France?']);
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
  socket.take({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' });
  socket.take({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'slow', name: 'search_knowledge', arguments: '{"query":"France"}' }] } });
  await tick();
  socket.take({ type: 'input_audio_buffer.speech_started' });
  release({ status: 'ok', passages: 'France' });
  await tick();
  assert.ok(socket.sent.some((event) => event.item?.call_id === 'slow'));
  assert.ok(!socket.sent.some((event) => event.type === 'response.create'));
  voice.close();
});

test('a drafted file answer is spoken even after a playback echo', async () => {
  const socket = new Socket();
  let release!: (value: unknown) => void;
  const voice = new OpenAiRealtime('test', 'gpt-realtime-2', 'pcm', '', '', { onAudio: () => {}, onClear: () => {} }, {
    definitions: [SEARCH_TOOL], execute: () => new Promise((resolve) => { release = resolve; }),
  }, () => socket as unknown as WebSocket);
  socket.take({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' });
  socket.take({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'slow', name: 'search_knowledge', arguments: '{"query":"Cosmo package"}' }] } });
  await tick();
  socket.take({ type: 'input_audio_buffer.speech_started' });
  release({ status: 'ok', reply: 'The Cosmo package includes 10 GB.' });
  await tick();
  const spoken = socket.sent.find((event) => event.type === 'response.create' && event.response?.instructions);
  assert.match(spoken?.response.instructions, /10 GB/);
  voice.close();
});

test('playback echo does not cancel a file answer that has started', async () => {
  const socket = new Socket();
  let cleared = 0;
  let release!: (value: unknown) => void;
  const voice = new OpenAiRealtime('test', 'gpt-realtime-2', 'pcm', '', '', { onAudio: () => {}, onClear: () => { cleared += 1; } }, {
    definitions: [SEARCH_TOOL], execute: () => new Promise((resolve) => { release = resolve; }),
  }, () => socket as unknown as WebSocket);
  socket.emit('open');
  assert.equal(socket.sent[0].session.audio.input.turn_detection.interrupt_response, false);
  socket.take({ type: 'conversation.item.input_audio_transcription.completed', transcript: '' });
  socket.take({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'slow', name: 'search_knowledge', arguments: '{"query":"Cosmo package"}' }] } });
  await tick();
  release({ status: 'ok', reply: 'The Cosmo package includes 10 GB.' });
  await tick();
  const before = socket.sent.length;
  socket.take({ type: 'input_audio_buffer.speech_started' });
  assert.equal(cleared, 0);
  assert.ok(!socket.sent.slice(before).some((event) => event.type === 'response.cancel'));
  voice.close();
});

test('the caller transcript is what gets searched, not a rewritten question', async () => {
  const socket = new Socket();
  const queries: unknown[] = [];
  const voice = new OpenAiRealtime('test', 'gpt-realtime-2', 'pcm', '', '', { onAudio: () => {}, onClear: () => {} }, {
    definitions: [SEARCH_TOOL], execute: async (_name, args) => { queries.push(args.query); return { status: 'ok', reply: 'The Cosmo package includes 10 GB.' }; },
  }, () => socket as unknown as WebSocket);
  socket.take({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Tell me about Cosmo' });
  socket.take({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'call-cosmo', name: 'search_knowledge', arguments: '{"query":"Հետաքրքրվում են՝ արդյոք տեսանյութերը հասանելի են նոր անդամների համար"}' }] } });
  await tick();
  assert.deepEqual(queries, ['Tell me about Cosmo']);
  voice.close();
});
