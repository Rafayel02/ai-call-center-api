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
          verify: true,
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
  assert.equal('instructions' in loop.data, false);
  assert.equal('verify' in loop.data, false);
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

test('accepts a topic switch whose topics both reach end', () => {
  const graph = parseScenarioGraph({
    nodes: [
      start,
      end,
      {
        id: 'switch-1',
        type: 'switch',
        position: { x: 20, y: 20 },
        data: {
          topics: [
            { id: 'hours', description: 'User asks for working hours', isDefault: false },
            { id: 'default', description: 'ignored', isDefault: true },
          ],
        },
      },
      speech,
    ],
    edges: [
      { id: 'e-2', source: 'switch-1', sourceHandle: 'default', target: 'end' },
      { id: 'e-3', source: 'switch-1', sourceHandle: 'hours', target: 'tts-1' },
      { id: 'e-4', source: 'tts-1', target: 'end' },
    ],
  });
  const routed = graph.nodes.find((node) => node.id === 'switch-1');
  assert.equal(routed?.type, 'switch');
  if (routed?.type !== 'switch') return;
  assert.equal(routed.data.topics[0]?.id, 'default');
  assert.equal(routed.data.topics[0]?.description, '');
  assert.equal(routed.data.topics[1]?.description, 'User asks for working hours');
  assert.equal(graph.edges.find((edge) => edge.id === 'e-3')?.sourceHandle, 'hours');
});

const menu = {
  id: 'menu-1',
  type: 'menu',
  position: { x: 10, y: 10 },
  data: {
    prompts: [{ ttsModelId: null, text: ' For Armenian press 1. ' }],
    options: [
      { id: 'hy', key: '1', label: 'Armenian' },
      { id: 'ru', key: '2', label: 'Russian' },
    ],
    defaultOptionId: 'hy',
  },
};

test('accepts a keypad menu whose options reach end and fills its defaults', () => {
  const graph = parseScenarioGraph({
    nodes: [start, menu, speech, end],
    edges: [
      { id: 'e-1', source: 'start', target: 'menu-1' },
      { id: 'e-2', source: 'menu-1', sourceHandle: 'hy', target: 'tts-1' },
      { id: 'e-3', source: 'menu-1', sourceHandle: 'ru', target: 'end' },
      { id: 'e-4', source: 'tts-1', target: 'end' },
    ],
  });
  const parsed = graph.nodes.find((node) => node.id === 'menu-1');
  assert.equal(parsed?.type, 'menu');
  if (parsed?.type !== 'menu') return;
  assert.equal(parsed.data.prompts[0]?.text, 'For Armenian press 1.');
  assert.equal(parsed.data.waitSeconds, 6);
  assert.equal(parsed.data.repeats, 1);
});

test('rejects a keypad menu option that does not lead to end', () => {
  assert.throws(
    () =>
      parseScenarioGraph({
        nodes: [start, menu, end],
        edges: [{ id: 'e-1', source: 'menu-1', sourceHandle: 'hy', target: 'end' }],
      }),
    /Connect key 2 through to End/,
  );
});

test('rejects two menu options on one key, a missing default, and a connection without an option', () => {
  const options = [
    { id: 'hy', key: '1', label: 'Armenian' },
    { id: 'ru', key: '1', label: 'Russian' },
  ];
  assert.throws(() => parseScenarioGraph({ nodes: [{ ...menu, data: { ...menu.data, options } }], edges: [] }), /Key 1 is used by two/);
  assert.throws(
    () => parseScenarioGraph({ nodes: [{ ...menu, data: { ...menu.data, defaultOptionId: 'en' } }], edges: [] }),
    /no key is pressed/,
  );
  assert.throws(
    () => parseScenarioGraph({ nodes: [menu, end], edges: [{ id: 'e-1', source: 'menu-1', target: 'end' }] }),
    /Connect each menu option/,
  );
});

test('fills the new loop settings and checks their range', () => {
  const graph = parseScenarioGraph({
    nodes: [{ id: 'loop-1', type: 'loop', position: { x: 0, y: 0 }, data: { sorryLine: ' Sorry, something went wrong. ' } }],
    edges: [],
  });
  const loop = graph.nodes[0];
  assert.equal(loop?.type, 'loop');
  if (loop?.type !== 'loop') return;
  assert.equal(loop.data.noInputSeconds, 15);
  assert.equal(loop.data.sorryLine, 'Sorry, something went wrong.');
  assert.throws(
    () => parseScenarioGraph({ nodes: [{ id: 'loop-1', type: 'loop', position: { x: 0, y: 0 }, data: { noInputSeconds: 2 } }], edges: [] }),
    /No input must be between 5 and 60/,
  );
});

test('rejects a topic that does not lead to end', () => {
  assert.throws(
    () =>
      parseScenarioGraph({
        nodes: [
          end,
          {
            id: 'switch-1',
            type: 'switch',
            position: { x: 0, y: 0 },
            data: { topics: [{ id: 'default', description: '', isDefault: true }] },
          },
        ],
        edges: [],
      }),
    /Connect Default through to End/,
  );
});
