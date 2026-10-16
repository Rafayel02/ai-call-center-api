import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScenarioGraph } from './scenario-graph';

const start = { id: 'start', type: 'start', position: { x: 1.2, y: 2.6 }, data: {} };
const speech = { id: 'tts-1', type: 'tts', position: { x: 40, y: 80 }, data: { modelId: null, text: 'Hello' } };
const end = { id: 'end', type: 'end', position: { x: 90, y: 80 }, data: {} };

test('accepts start connected through text to speech to end', () => {
  const graph = parseScenarioGraph({
    nodes: [end, start, speech],
    edges: [
      { id: 'e-1', source: 'start', target: 'tts-1' },
      { id: 'e-2', source: 'tts-1', target: 'end' },
    ],
  });

  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ['end', 'start', 'tts-1'],
  );
  assert.equal(graph.nodes.find((node) => node.id === 'start')?.position.x, 1);
  assert.deepEqual(graph.nodes.find((node) => node.id === 'tts-1')?.data, { modelId: null, text: 'Hello' });
});

test('rejects a direct connection from start to end', () => {
  assert.throws(
    () =>
      parseScenarioGraph({
        nodes: [start, end],
        edges: [{ id: 'e-1', source: 'start', target: 'end' }],
      }),
    /Connect Start to Text to speech/,
  );
});

test('rejects a second start and a speech model id', () => {
  assert.throws(
    () => parseScenarioGraph({ nodes: [start, { ...start, id: 'start-2' }], edges: [] }),
    /one Start/,
  );
  assert.throws(
    () =>
      parseScenarioGraph({
        nodes: [{ ...speech, data: { modelId: 'voice-1', text: 'Hello' } }],
        edges: [],
      }),
    /Speech models are not available yet/,
  );
});
