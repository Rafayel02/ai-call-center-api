import assert from 'node:assert/strict';
import test from 'node:test';
import { parseScenarioGraph } from '../scenarios/scenario-graph';
import { ScenarioVoice } from './scenario-voice';

function fixture(policy = 'required', replyMode = 'realtime') {
  return parseScenarioGraph({ nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
    { id: 'roaming', type: 'loop', position: { x: 0, y: 0 }, data: { instructions: 'Ask the destination country; explain roaming, then continue.', knowledgeSearch: policy, replyMode, maxTurns: 3 } },
    { id: 'closing', type: 'closing', position: { x: 0, y: 0 }, data: {} },
    { id: 'end', type: 'end', position: { x: 0, y: 0 }, data: {} },
  ], edges: [
    { id: 'a', source: 'start', target: 'roaming' },
    { id: 'b', source: 'roaming', target: 'closing' },
    { id: 'c', source: 'closing', target: 'roaming', sourceHandle: 'questions' },
    { id: 'd', source: 'closing', target: 'end', sourceHandle: 'done' },
  ] });
}

test('required roaming lookup reaches the LLM before the voice receives a reply', async () => {
  const calls: string[] = [];
  const events: Record<string, unknown>[] = [];
  const flow = new ScenarioVoice(fixture('required', 'llm'), 'en', {
    search: async (query) => { calls.push(query); return 'Roaming in France costs 100 AMD.'; },
    reply: async (query, instructions, passages) => { calls.push('llm'); assert.match(instructions, /destination/); assert.match(passages!, /100 AMD/); return 'Roaming in France costs 100 AMD.'; },
    trace: (event) => events.push(event),
  });
  const result = await flow.execute('run_step', { nodeId: 'roaming', revision: 0, query: 'Roaming in France?', search: false }) as { status: string; reply: string };
  assert.equal(result.status, 'ok');
  assert.match(result.reply, /100 AMD/);
  assert.deepEqual(calls, ['Roaming in France?', 'llm']);
  assert.ok(events.some((event) => event.type === 'knowledge.result' && event.status === 'ok'));
  assert.equal(flow.state().nodeId, 'roaming');
});

test('off never searches; optional searches only on request', async () => {
  for (const [policy, requested, expected] of [['off', true, 0], ['optional', false, 0], ['optional', true, 1]] as const) {
    let searches = 0;
    const flow = new ScenarioVoice(fixture(policy), 'hy', { search: async () => { searches++; return 'Facts'; }, reply: async () => '', trace: () => {} });
    await flow.execute('run_step', { nodeId: 'roaming', revision: 0, query: 'Roaming?', search: requested });
    assert.equal(searches, expected);
  }
});

test('lookup errors are distinct from missing facts and do not call the LLM', async () => {
  for (const fail of [false, true]) {
    const flow = new ScenarioVoice(fixture('required', 'llm'), 'en', {
      search: async () => { if (fail) throw Error('Provider unavailable'); return 'No passage matches this question.'; },
      reply: async () => { assert.fail('Must not draft from failed or missing search results'); }, trace: () => {},
    });
    const result = await flow.execute('run_step', { nodeId: 'roaming', revision: 0, query: 'Roaming?' }) as { status: string };
    assert.equal(result.status, fail ? 'error' : 'no_match');
  }
});

test('server rejects skipped, replayed, invalid, and concurrent transitions', async () => {
  let release!: (value: string) => void;
  const flow = new ScenarioVoice(fixture(), 'en', { search: () => new Promise((resolve) => { release = resolve; }), reply: async () => '', trace: () => {} });
  assert.equal((await flow.execute('advance_scenario', { nodeId: 'end', revision: 0 }) as { status: string }).status, 'stale_step');
  const pending = flow.execute('run_step', { nodeId: 'roaming', revision: 0, query: 'France roaming?' });
  assert.equal((await flow.execute('advance_scenario', { nodeId: 'roaming', revision: 0 }) as { status: string }).status, 'busy');
  release('France facts'); await pending;
  await flow.execute('advance_scenario', { nodeId: 'roaming', revision: 0 });
  assert.equal(flow.state().nodeId, 'closing');
  await flow.execute('advance_scenario', { nodeId: 'roaming', revision: 0 });
  await flow.execute('advance_scenario', { nodeId: 'closing', revision: 1, route: 'invented' });
  assert.equal(flow.state().nodeId, 'closing');
  await flow.execute('advance_scenario', { nodeId: 'closing', revision: 1, route: 'questions' });
  assert.equal(flow.state().nodeId, 'roaming');
  assert.equal(flow.state().revision, 2);
  await flow.execute('advance_scenario', { nodeId: 'roaming', revision: 2 });
  await flow.execute('advance_scenario', { nodeId: 'closing', revision: 3, route: 'done' });
  assert.equal(flow.state().finished, true);
});

test('loop limits and graph policy validation are enforced', async () => {
  const flow = new ScenarioVoice(fixture(), 'en', { search: async () => 'Facts', reply: async () => '', trace: () => {} });
  for (let i = 0; i < 3; i++) await flow.execute('run_step', { nodeId: 'roaming', revision: 0, query: 'France?' });
  assert.equal((await flow.execute('run_step', { nodeId: 'roaming', revision: 0, query: 'France?' }) as { status: string }).status, 'turn_limit');
  assert.throws(() => fixture('invented'));
  assert.throws(() => fixture('required', 'invented'));
  const graph = fixture(); graph.edges = graph.edges.filter((edge) => edge.source !== 'start');
  assert.throws(() => new ScenarioVoice(graph, 'en', { search: async () => '', reply: async () => '', trace: () => {} }));
});
