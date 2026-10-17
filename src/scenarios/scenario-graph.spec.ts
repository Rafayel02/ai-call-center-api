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

test('rejects a second start and a model id that is not a saved model', () => {
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
    /Choose a text-to-speech model/,
  );
});

test('accepts a conversational loop and keeps its inquiry settings', () => {
  const modelId = '11111111-1111-4111-8111-111111111111';
  const graph = parseScenarioGraph({
    nodes: [
      start,
      {
        id: 'loop-1',
        type: 'loop',
        position: { x: 20, y: 30 },
        data: {
          sttModelId: modelId,
          ttsModelId: null,
          llmModelId: modelId,
          silenceSeconds: 4.2,
          fillers: [' Just a moment. ', ''],
          instructions: 'Find the booking.',
          maxTurns: 8,
        },
      },
      end,
    ],
    edges: [
      { id: 'e-1', source: 'start', target: 'loop-1' },
      { id: 'e-2', source: 'loop-1', target: 'end' },
    ],
  });
  const loop = graph.nodes.find((node) => node.id === 'loop-1');
  assert.equal(loop?.type, 'loop');
  if (loop?.type !== 'loop') return;
  assert.equal(loop.data.silenceSeconds, 4);
  assert.deepEqual(loop.data.fillers, ['Just a moment.']);
  assert.equal(loop.data.instructions, 'Find the booking.');
  assert.equal(loop.data.sttModelId, modelId);
});

test('rejects a conversational loop with too many delay lines', () => {
  assert.throws(
    () =>
      parseScenarioGraph({
        nodes: [
          {
            id: 'loop-1',
            type: 'loop',
            position: { x: 0, y: 0 },
            data: { fillers: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] },
          },
        ],
        edges: [],
      }),
    /at most 8 delay lines/,
  );
});

test('keeps a saved text-to-speech model id', () => {
  const modelId = '11111111-1111-4111-8111-111111111111';
  const graph = parseScenarioGraph({
    nodes: [{ ...speech, data: { modelId, text: 'Hello' } }],
    edges: [],
  });
  const data = graph.nodes[0]?.data;
  assert.equal(data && 'modelId' in data ? data.modelId : null, modelId);
});
