import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScenarioGraph } from './scenario-graph';
import { fixedLines, ModelAvailability, planScenario, topicsAhead } from './scenario-plan';

const TTS = '11111111-1111-4111-8111-111111111111';
const STT = '22222222-2222-4222-8222-222222222222';
const LLM = '33333333-3333-4333-8333-333333333333';

const enabled: ModelAvailability = {
  tts: new Map([[TTS, true]]),
  stt: new Map([[STT, true]]),
  llm: new Map([[LLM, true]]),
};

const loopData = {
  sttModelId: STT,
  ttsModelId: TTS,
  llmModelId: LLM,
  fillers: ['One moment.'],
  sorryLine: 'Sorry, an operator will call you back.',
};

function callGraph(overrides: { loop?: Record<string, unknown>; menuPrompt?: Record<string, unknown> } = {}) {
  return parseScenarioGraph({
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'menu',
        type: 'menu',
        position: { x: 0, y: 0 },
        data: {
          prompts: [{ ttsModelId: TTS, text: 'For Armenian press 1.', ...overrides.menuPrompt }],
          options: [
            { id: 'hy', key: '1', label: 'Armenian' },
            { id: 'en', key: '2', label: 'English' },
          ],
          defaultOptionId: 'hy',
        },
      },
      { id: 'greet', type: 'tts', position: { x: 0, y: 0 }, data: { modelId: TTS, text: 'Hello.' } },
      { id: 'loop', type: 'loop', position: { x: 0, y: 0 }, data: { ...loopData, ...overrides.loop } },
      {
        id: 'switch',
        type: 'switch',
        position: { x: 0, y: 0 },
        data: {
          topics: [
            { id: 'default', description: '', isDefault: true },
            { id: 'hours', description: 'Working hours', isDefault: false },
          ],
        },
      },
      { id: 'hours-line', type: 'tts', position: { x: 0, y: 0 }, data: { modelId: TTS, text: 'We open at nine.' } },
      { id: 'end', type: 'end', position: { x: 0, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'menu' },
      { id: 'e2', source: 'menu', sourceHandle: 'hy', target: 'greet' },
      { id: 'e3', source: 'menu', sourceHandle: 'en', target: 'end' },
      { id: 'e4', source: 'greet', target: 'loop' },
      { id: 'e5', source: 'loop', target: 'switch' },
      { id: 'e6', source: 'switch', sourceHandle: 'default', target: 'end' },
      { id: 'e7', source: 'switch', sourceHandle: 'hours', target: 'hours-line' },
      { id: 'e8', source: 'hours-line', target: 'end' },
    ],
  });
}

test('a menu, a loop, and a topic switch that reach end can run', () => {
  assert.deepEqual(planScenario(callGraph(), enabled), { ok: true });
});

test('a loop without a sorry line, or a menu prompt without text, cannot run', () => {
  assert.deepEqual(planScenario(callGraph({ loop: { sorryLine: '' } }), enabled), {
    ok: false,
    message: 'Add a sorry line for each conversational loop.',
  });
  assert.deepEqual(planScenario(callGraph({ menuPrompt: { text: '' } }), enabled), {
    ok: false,
    message: 'Each menu prompt needs something to say.',
  });
});

test('a disabled or missing model stops the plan', () => {
  assert.deepEqual(planScenario(callGraph(), { ...enabled, llm: new Map([[LLM, false]]) }), {
    ok: false,
    message: 'Enable the LLM used by each conversational loop.',
  });
  assert.deepEqual(planScenario(callGraph(), { ...enabled, stt: new Map() }), {
    ok: false,
    message: 'A conversational loop uses a speech-to-text model that is no longer available.',
  });
});

test('a topic switch needs a loop with an LLM before it', () => {
  const full = callGraph();
  const graph = {
    nodes: full.nodes.filter((node) => node.id !== 'loop'),
    edges: [...full.edges.filter((edge) => edge.source !== 'greet' && edge.source !== 'loop'), { id: 'e9', source: 'greet', target: 'switch' }],
  };
  assert.deepEqual(planScenario(graph, enabled), {
    ok: false,
    message: 'Put a conversational loop with an LLM before the topic switch.',
  });
});

test('the loop sees the topics of the switch ahead', () => {
  assert.deepEqual(topicsAhead(callGraph(), 'loop'), {
    defaultTopicId: 'default',
    topics: [{ id: 'hours', description: 'Working hours' }],
  });
  assert.equal(topicsAhead(callGraph(), 'hours-line'), null);
});

/** Start → loop → closing; No more questions → switch, Still has questions → `questions`. */
function closingGraph(options: { closing?: Record<string, unknown>; againTo?: string } = {}) {
  const full = callGraph();
  const again = options.againTo
    ? {
        nodes: [
          { id: 'again-1', type: 'tts', position: { x: 0, y: 0 }, data: { modelId: TTS, text: 'Sure.' } },
          { id: 'again-2', type: 'tts', position: { x: 0, y: 0 }, data: { modelId: TTS, text: 'Go ahead.' } },
        ],
        edges: [
          { id: 'e12', source: 'again-1', target: 'again-2' },
          { id: 'e13', source: 'again-2', target: options.againTo },
        ],
      }
    : { nodes: [], edges: [] };
  return parseScenarioGraph({
    nodes: [
      ...full.nodes.filter((node) => node.id !== 'menu'),
      {
        id: 'closing',
        type: 'closing',
        position: { x: 0, y: 0 },
        data: { sttModelId: STT, ttsModelId: TTS, llmModelId: LLM, text: 'Anything else?', ...options.closing },
      },
      ...again.nodes,
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'greet' },
      ...full.edges.filter((edge) => edge.source !== 'start' && edge.source !== 'menu' && edge.source !== 'loop'),
      { id: 'e9', source: 'loop', target: 'closing' },
      { id: 'e10', source: 'closing', sourceHandle: 'questions', target: options.againTo ? 'again-1' : 'loop' },
      { id: 'e11', source: 'closing', sourceHandle: 'done', target: 'switch' },
      ...again.edges,
    ],
  });
}

test('a closing step can send the caller back to the loop, and the loop sees the topics past it', () => {
  assert.deepEqual(planScenario(closingGraph(), enabled), { ok: true });
  assert.deepEqual(planScenario(closingGraph({ againTo: 'loop' }), enabled), { ok: true });
  assert.deepEqual(topicsAhead(closingGraph(), 'loop'), {
    defaultTopicId: 'default',
    topics: [{ id: 'hours', description: 'Working hours' }],
  });
  assert.ok(fixedLines(closingGraph()).some((line) => line.text === 'Anything else?' && line.modelId === TTS));
});

test('a closing step without its models cannot run, and a loop that skips it is still refused', () => {
  assert.deepEqual(planScenario(closingGraph({ closing: { llmModelId: null } }), enabled), {
    ok: false,
    message: 'Choose an LLM for each closing step.',
  });
  assert.deepEqual(planScenario(closingGraph({ closing: { sttModelId: '44444444-4444-4444-8444-444444444444' } }), enabled), {
    ok: false,
    message: 'A closing step uses a speech-to-text model that is no longer available.',
  });
  assert.deepEqual(planScenario(closingGraph({ againTo: 'again-1' }), enabled), { ok: false, message: 'The scenario loops back to an earlier step.' });
});

test('fixed lines cover steps, menu prompts, delay lines, and sorry lines once each', () => {
  const lines = fixedLines(callGraph({ loop: { fillers: ['One moment.', 'Hello.'] } })).map((line) => line.text);
  assert.deepEqual(lines.sort(), ['For Armenian press 1.', 'Hello.', 'One moment.', 'Sorry, an operator will call you back.', 'We open at nine.']);
});
