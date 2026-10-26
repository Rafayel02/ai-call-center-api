import assert from 'node:assert/strict';
import test from 'node:test';
import { ScenarioGraph } from '../scenarios/scenario-graph';
import { promptBrief, readVoiceMode, realtimeBrief } from './realtime-brief';

test('a scenario becomes a spoken briefing and opens with its first line', () => {
  const graph: ScenarioGraph = {
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
      { id: 'hello', type: 'tts', position: { x: 0, y: 0 }, data: { modelId: null, texts: { en: 'Hello from the clinic.' } } },
      { id: 'loop', type: 'loop', position: { x: 0, y: 0 }, data: { sttModelId: null, ttsModelId: null, llmModelId: null, silenceSeconds: 1, maxTurns: 4 } },
      { id: 'topics', type: 'switch', position: { x: 0, y: 0 }, data: { topics: [{ id: 'hours', description: 'Opening hours', isDefault: false }, { id: 'other', description: 'Anything else', isDefault: true }] } },
      { id: 'bye', type: 'closing', position: { x: 0, y: 0 }, data: { sttModelId: null, ttsModelId: null, llmModelId: null, silenceSeconds: 1, texts: { en: 'Anything else?' } } },
      { id: 'end', type: 'end', position: { x: 0, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'a', source: 'start', target: 'hello' },
      { id: 'b', source: 'hello', target: 'loop' },
      { id: 'c', source: 'loop', target: 'topics' },
      { id: 'd', source: 'topics', target: 'bye', sourceHandle: 'hours' },
      { id: 'e', source: 'topics', target: 'bye', sourceHandle: 'other' },
      { id: 'f', source: 'bye', target: 'end', sourceHandle: 'done' },
    ],
  };
  const brief = realtimeBrief(graph, 'en');
  assert.match(brief.greeting, /Hello from the clinic/);
  assert.match(brief.instructions, /Opening hours/);
  assert.match(brief.instructions, /Anything else\?/);
  assert.doesNotMatch(brief.instructions, /Anything else\.\n/);
});

test('a context prompt is the only source the call may use', () => {
  const brief = promptBrief('hy', 'We are open from 9 to 6. A visit costs 5000 dram.');
  assert.match(brief.instructions, /We are open from 9 to 6/);
  assert.match(brief.instructions, /only information you may use/);
  assert.match(brief.instructions, /Do not answer the out-of-scope question/);
  assert.match(brief.instructions, /Speak only Armenian/);
  assert.match(brief.instructions, /Do not switch languages/);
  assert.doesNotMatch(brief.instructions, /switch to that language/);
  assert.equal(brief.greeting, 'Բարև, ինչով կարող եմ օգնել:');
  assert.match(promptBrief('en', '   ').instructions, /no context yet/);
  assert.equal(readVoiceMode('prompt'), 'prompt');
  assert.equal(readVoiceMode('other'), 'scenario');
});
