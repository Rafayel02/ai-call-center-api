import assert from 'node:assert/strict';
import test from 'node:test';
import { ScenarioGraph } from '../scenarios/scenario-graph';
import { realtimeBrief } from './realtime-brief';

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
