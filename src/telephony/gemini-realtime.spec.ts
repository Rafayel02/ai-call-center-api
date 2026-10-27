import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { GeminiRealtime } from './gemini-realtime';
import { SEARCH_TOOL } from './realtime-tools';

test('Gemini receives the same controlled tools and suppresses cancelled results', async () => {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; sent: Array<Record<string, any>>; send(raw: string): void; close(): void };
  socket.readyState = WebSocket.OPEN;
  socket.sent = [];
  socket.send = (raw) => { socket.sent.push(JSON.parse(raw)); };
  socket.close = () => { socket.emit('close', 1000, ''); };
  let release!: (value: unknown) => void;
  const voice = new GeminiRealtime('test', 'gemini-3.8-live', 'pcm', 'Follow steps.', 'Hello', { onAudio: () => {}, onClear: () => {} }, {
    definitions: [SEARCH_TOOL], execute: () => new Promise((resolve) => { release = resolve; }),
  }, () => socket as unknown as WebSocket);
  socket.emit('open');
  const declaration = socket.sent[0].setup.tools[0].functionDeclarations[0];
  assert.equal(declaration.name, 'search_knowledge');
  assert.equal(declaration.behavior, 'NON_BLOCKING');
  assert.equal(declaration.parameters.type, 'OBJECT');
  assert.equal(declaration.parameters.properties.query.type, 'STRING');
  socket.emit('message', JSON.stringify({ toolCall: { functionCalls: [{ id: 'lookup', name: 'search_knowledge', args: { query: 'France roaming' } }] } }));
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit('message', JSON.stringify({ toolCallCancellation: { ids: ['lookup'] } }));
  release({ passages: 'France facts' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!socket.sent.some((event) => event.toolResponse));
  voice.close();
});
