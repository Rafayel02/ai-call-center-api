import { branchHandles, ClosingNodeData, ScenarioGraph, ScenarioGraphNode, LoopNodeData } from './scenario-graph';

/** Whether each saved model a graph uses exists, and if so whether it is enabled. */
export interface ModelAvailability {
  tts: ReadonlyMap<string, boolean>;
  stt: ReadonlyMap<string, boolean>;
  llm: ReadonlyMap<string, boolean>;
}

export type ScenarioPlan = { ok: true } | { ok: false; message: string };

export interface LoopTopics {
  defaultTopicId: string;
  topics: Array<{ id: string; description: string }>;
}

export interface FixedLine {
  modelId: string;
  text: string;
}

function modelProblem(models: ReadonlyMap<string, boolean>, id: string, missing: string, disabled: string): string | null {
  const enabled = models.get(id);
  if (enabled === undefined) return missing;
  return enabled ? null : disabled;
}

function loopProblem(data: LoopNodeData, models: ModelAvailability): string | null {
  if (!data.sttModelId) return 'Choose a speech-to-text model for each conversational loop.';
  if (!data.ttsModelId) return 'Choose a text-to-speech model for each conversational loop.';
  if (!data.llmModelId) return 'Choose an LLM for each conversational loop.';
  if (data.fillers.length === 0) return 'Add a delay line for each conversational loop.';
  if (!data.sorryLine) return 'Add a sorry line for each conversational loop.';
  return (
    modelProblem(models.stt, data.sttModelId, 'A conversational loop uses a speech-to-text model that is no longer available.', 'Enable the speech-to-text model used by each conversational loop.') ??
    modelProblem(models.tts, data.ttsModelId, 'A conversational loop uses a text-to-speech model that is no longer available.', 'Enable the speech model used by each conversational loop.') ??
    modelProblem(models.llm, data.llmModelId, 'A conversational loop uses an LLM that is no longer available.', 'Enable the LLM used by each conversational loop.')
  );
}

function stepProblem(node: ScenarioGraphNode, models: ModelAvailability): string | null {
  if (node.type === 'tts') {
    if (!node.data.modelId) return 'Choose a speech model for each text-to-speech step.';
    if (!node.data.text.trim()) return 'Each text-to-speech step needs something to say.';
    return modelProblem(models.tts, node.data.modelId, 'A text-to-speech step uses a model that is no longer available.', 'Enable the speech model used by each text-to-speech step.');
  }
  if (node.type === 'loop') return loopProblem(node.data, models);
  if (node.type === 'menu') {
    for (const prompt of node.data.prompts) {
      if (!prompt.ttsModelId) return 'Choose a speech model for each menu prompt.';
      if (!prompt.text) return 'Each menu prompt needs something to say.';
      const problem = modelProblem(models.tts, prompt.ttsModelId, 'A menu prompt uses a model that is no longer available.', 'Enable the speech model used by each menu prompt.');
      if (problem) return problem;
    }
    if (node.data.options.some((option) => !option.label)) return 'Name each menu option.';
  }
  if (node.type === 'closing') {
    const data: ClosingNodeData = node.data;
    if (!data.sttModelId) return 'Choose a speech-to-text model for each closing step.';
    if (!data.ttsModelId) return 'Choose a text-to-speech model for each closing step.';
    if (!data.llmModelId) return 'Choose an LLM for each closing step.';
    if (!data.text.trim()) return 'Each closing step needs a question.';
    return (
      modelProblem(models.stt, data.sttModelId, 'A closing step uses a speech-to-text model that is no longer available.', 'Enable the speech-to-text model used by each closing step.') ??
      modelProblem(models.tts, data.ttsModelId, 'A closing step uses a text-to-speech model that is no longer available.', 'Enable the speech model used by each closing step.') ??
      modelProblem(models.llm, data.llmModelId, 'A closing step uses an LLM that is no longer available.', 'Enable the LLM used by each closing step.')
    );
  }
  return null;
}

/**
 * Checks that a call can run the graph from Start to End: the rules the designer's Play used, plus the Keypad menu
 * and the sorry line. Returns the first problem found. The only way back to an earlier step is a closing step's
 * Still has questions, which may return to any step before that closing step.
 */
export function planScenario(graph: ScenarioGraph, models: ModelAvailability): ScenarioPlan {
  const start = graph.nodes.find((node) => node.type === 'start');
  if (!start) return { ok: false, message: 'Add a Start step.' };

  const visit = (nodeId: string, seen: Set<string>, hasLlm: boolean, returnTo: ReadonlySet<string> | null): string | null => {
    if (seen.has(nodeId)) return returnTo?.has(nodeId) ? null : 'The scenario loops back to an earlier step.';
    const node = graph.nodes.find((item) => item.id === nodeId);
    if (!node) return 'A connection points at a missing step.';
    if (node.type === 'end') return null;
    const nextSeen = new Set(seen);
    nextSeen.add(nodeId);

    const problem = stepProblem(node, models);
    if (problem) return problem;
    if (node.type === 'loop') hasLlm = Boolean(node.data.llmModelId);
    if (node.type === 'switch' && !hasLlm) return 'Put a conversational loop with an LLM before the topic switch.';

    if (node.type === 'closing') {
      const questions = branchTarget(graph, node.id, 'questions');
      const done = branchTarget(graph, node.id, 'done');
      if (!questions) return 'Connect Still has questions.';
      if (!done) return 'Connect No more questions through to End.';
      return visit(questions, nextSeen, hasLlm, nextSeen) ?? visit(done, nextSeen, hasLlm, returnTo);
    }

    const handles = branchHandles(node);
    if (handles) {
      for (const handle of handles) {
        const target = branchTarget(graph, node.id, handle);
        if (!target) return node.type === 'menu' ? 'Connect every menu option through to End.' : 'Connect every topic through to End.';
        const branchProblem = visit(target, nextSeen, hasLlm, returnTo);
        if (branchProblem) return branchProblem;
      }
      return null;
    }

    const outgoing = graph.edges.filter((edge) => edge.source === nodeId);
    if (outgoing.length === 0) return 'Connect the steps from Start through to End.';
    if (outgoing.length > 1) return 'A step can lead to only one next step.';
    return visit(outgoing[0].target, nextSeen, hasLlm, returnTo);
  };

  const problem = visit(start.id, new Set(), false, null);
  return problem ? { ok: false, message: problem } : { ok: true };
}

/** The node a topic or menu option leads to. */
export function branchTarget(graph: ScenarioGraph, nodeId: string, handle: string): string | null {
  return graph.edges.find((edge) => edge.source === nodeId && edge.sourceHandle === handle)?.target ?? null;
}

/** The node after a step that has one next step. */
export function nextStep(graph: ScenarioGraph, nodeId: string): ScenarioGraphNode | null {
  const outgoing = graph.edges.filter((edge) => edge.source === nodeId);
  if (outgoing.length !== 1) return null;
  return graph.nodes.find((node) => node.id === outgoing[0].target) ?? null;
}

/** The topics of the first Topic switch after a loop, following single next steps and a closing step's No more questions only. */
export function topicsAhead(graph: ScenarioGraph, fromId: string): LoopTopics | null {
  const seen = new Set<string>([fromId]);
  let current = nextStep(graph, fromId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.type === 'end') return null;
    if (current.type === 'closing') {
      const done = branchTarget(graph, current.id, 'done');
      current = done ? (graph.nodes.find((node) => node.id === done) ?? null) : null;
      continue;
    }
    if (current.type === 'switch') {
      const fallback = current.data.topics.find((topic) => topic.isDefault);
      const described = current.data.topics.filter((topic) => !topic.isDefault && topic.description);
      if (!fallback || described.length === 0) return null;
      return {
        defaultTopicId: fallback.id,
        topics: described.map((topic) => ({ id: topic.id, description: topic.description })),
      };
    }
    current = nextStep(graph, current.id);
  }
  return null;
}

function reachable(graph: ScenarioGraph): ScenarioGraphNode[] {
  const start = graph.nodes.find((node) => node.type === 'start');
  if (!start) return [];
  const seen = new Set<string>();
  const queue = [start.id];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of graph.edges) if (edge.source === id) queue.push(edge.target);
  }
  return graph.nodes.filter((node) => seen.has(node.id));
}

/** Every line known before a call on the steps a call can reach, once each: what publishing renders as phone clips. */
export function fixedLines(graph: ScenarioGraph): FixedLine[] {
  const lines = new Map<string, FixedLine>();
  const add = (modelId: string | null, text: string) => {
    const spoken = text.trim();
    if (!modelId || !spoken) return;
    lines.set(`${modelId}\0${spoken}`, { modelId, text: spoken });
  };
  for (const node of reachable(graph)) {
    if (node.type === 'tts') add(node.data.modelId, node.data.text);
    if (node.type === 'menu') for (const prompt of node.data.prompts) add(prompt.ttsModelId, prompt.text);
    if (node.type === 'loop') {
      for (const filler of node.data.fillers) add(node.data.ttsModelId, filler);
      add(node.data.ttsModelId, node.data.sorryLine);
    }
    if (node.type === 'closing') add(node.data.ttsModelId, node.data.text);
  }
  return [...lines.values()];
}

/** The saved model ids a graph refers to, by kind. */
export function graphModelIds(graph: ScenarioGraph) {
  const tts = new Set<string>();
  const stt = new Set<string>();
  const llm = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type === 'tts' && node.data.modelId) tts.add(node.data.modelId);
    if (node.type === 'menu') for (const prompt of node.data.prompts) if (prompt.ttsModelId) tts.add(prompt.ttsModelId);
    if (node.type === 'loop' || node.type === 'closing') {
      if (node.data.ttsModelId) tts.add(node.data.ttsModelId);
      if (node.data.sttModelId) stt.add(node.data.sttModelId);
      if (node.data.llmModelId) llm.add(node.data.llmModelId);
    }
  }
  return { tts: [...tts], stt: [...stt], llm: [...llm] };
}
