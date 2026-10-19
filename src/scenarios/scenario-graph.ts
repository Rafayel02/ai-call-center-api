import { BadRequestException } from '@nestjs/common';

export const SCENARIO_NODE_TYPES = ['start', 'end', 'tts', 'loop', 'switch', 'menu'] as const;

export type ScenarioNodeType = (typeof SCENARIO_NODE_TYPES)[number];

export interface TtsNodeData {
  modelId: string | null;
  text: string;
}

export interface LoopNodeData {
  sttModelId: string | null;
  ttsModelId: string | null;
  llmModelId: string | null;
  silenceSeconds: number;
  fillers: string[];
  maxTurns: number;
  noInputSeconds: number;
  sorryLine: string;
}

export interface MenuPrompt {
  ttsModelId: string | null;
  text: string;
}

export interface MenuOption {
  id: string;
  key: string;
  label: string;
}

export interface MenuNodeData {
  prompts: MenuPrompt[];
  options: MenuOption[];
  defaultOptionId: string;
  waitSeconds: number;
  repeats: number;
}

export interface SwitchTopic {
  id: string;
  description: string;
  isDefault: boolean;
}

export interface SwitchNodeData {
  topics: SwitchTopic[];
}

export type ScenarioGraphNode =
  | { id: string; type: 'start' | 'end'; position: { x: number; y: number }; data: Record<string, never> }
  | { id: string; type: 'tts'; position: { x: number; y: number }; data: TtsNodeData }
  | { id: string; type: 'loop'; position: { x: number; y: number }; data: LoopNodeData }
  | { id: string; type: 'switch'; position: { x: number; y: number }; data: SwitchNodeData }
  | { id: string; type: 'menu'; position: { x: number; y: number }; data: MenuNodeData };

export interface ScenarioGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

export interface ScenarioGraph {
  nodes: ScenarioGraphNode[];
  edges: ScenarioGraphEdge[];
}

const CONNECTIONS: Record<ScenarioNodeType, readonly ScenarioNodeType[]> = {
  start: ['tts', 'loop', 'menu'],
  end: [],
  tts: ['tts', 'loop', 'switch', 'menu', 'end'],
  loop: ['tts', 'loop', 'switch', 'menu', 'end'],
  switch: ['tts', 'loop', 'switch', 'menu', 'end'],
  menu: ['tts', 'loop', 'switch', 'menu', 'end'],
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/** The handles a branching step offers: one per topic or menu option. Other steps have none. */
export function branchHandles(node: ScenarioGraphNode): string[] | null {
  if (node.type === 'switch') return node.data.topics.map((topic) => topic.id);
  if (node.type === 'menu') return node.data.options.map((option) => option.id);
  return null;
}

export function emptyScenarioGraph(): ScenarioGraph {
  return { nodes: [], edges: [] };
}

export function parseScenarioGraph(input: unknown): ScenarioGraph {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('Scenario graph must include nodes and edges.');
  }
  const record = input as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
    throw new BadRequestException('Scenario graph must include nodes and edges.');
  }
  if (record.nodes.length > 80 || record.edges.length > 160) {
    throw new BadRequestException('This scenario has too many steps.');
  }

  const nodes = record.nodes.map(parseNode);
  const ids = new Set<string>();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new BadRequestException('Each step needs its own id.');
    ids.add(node.id);
  }
  if (nodes.filter((node) => node.type === 'start').length > 1) {
    throw new BadRequestException('A scenario can have one Start.');
  }
  if (nodes.filter((node) => node.type === 'end').length > 1) {
    throw new BadRequestException('A scenario can have one End.');
  }

  const edges = record.edges.map((edge) => parseEdge(edge, nodes));
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  const topicLanes = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) throw new BadRequestException('Each connection needs its own id.');
    edgeIds.add(edge.id);
    const pair = `${edge.source}:${edge.sourceHandle ?? ''}>${edge.target}`;
    if (pairs.has(pair)) throw new BadRequestException('Those steps are already connected.');
    pairs.add(pair);
    if (edge.sourceHandle) {
      const lane = `${edge.source}:${edge.sourceHandle}`;
      if (topicLanes.has(lane)) throw new BadRequestException('A topic or menu option can lead to only one next step.');
      topicLanes.add(lane);
    }
  }
  assertTopicsReachEnd(nodes, edges);
  assertOptionsReachEnd(nodes, edges);

  nodes.sort((left, right) => left.id.localeCompare(right.id));
  edges.sort((left, right) => left.id.localeCompare(right.id));
  return { nodes, edges };
}

export function readScenarioGraph(value: unknown): ScenarioGraph {
  try {
    return parseScenarioGraph(value);
  } catch {
    return emptyScenarioGraph();
  }
}

function parseNode(value: unknown): ScenarioGraphNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('A scenario step is invalid.');
  }
  const node = value as { id?: unknown; type?: unknown; position?: unknown; data?: unknown };
  if (typeof node.id !== 'string' || !ID_PATTERN.test(node.id)) {
    throw new BadRequestException('A scenario step has an invalid id.');
  }
  if (!isNodeType(node.type)) {
    throw new BadRequestException('A scenario step has an unknown type.');
  }
  const position = parsePosition(node.position);
  if (node.type === 'tts') {
    return { id: node.id, type: node.type, position, data: parseTtsData(node.data) };
  }
  if (node.type === 'loop') {
    return { id: node.id, type: node.type, position, data: parseLoopData(node.data) };
  }
  if (node.type === 'switch') {
    return { id: node.id, type: node.type, position, data: parseSwitchData(node.data) };
  }
  if (node.type === 'menu') {
    return { id: node.id, type: node.type, position, data: parseMenuData(node.data) };
  }
  return { id: node.id, type: node.type, position, data: {} };
}

function isNodeType(value: unknown): value is ScenarioNodeType {
  return typeof value === 'string' && (SCENARIO_NODE_TYPES as readonly string[]).includes(value);
}

function parsePosition(value: unknown): { x: number; y: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('A scenario step has an invalid position.');
  }
  const position = value as { x?: unknown; y?: unknown };
  if (!isCoordinate(position.x) || !isCoordinate(position.y)) {
    throw new BadRequestException('A scenario step has an invalid position.');
  }
  return { x: Math.round(position.x), y: Math.round(position.y) };
}

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000;
}

const MODEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseLoopData(value: unknown): LoopNodeData {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    sttModelId: parseModelId(data.sttModelId, 'Choose a speech-to-text model.'),
    ttsModelId: parseModelId(data.ttsModelId, 'Choose a text-to-speech model.'),
    llmModelId: parseModelId(data.llmModelId, 'Choose an LLM.'),
    silenceSeconds: parseBoundedInt(data.silenceSeconds, 4, 1, 30, 'Silence must be between 1 and 30 seconds.'),
    fillers: parseFillers(data.fillers),
    maxTurns: parseBoundedInt(data.maxTurns, 8, 1, 20, 'Max turns must be between 1 and 20.'),
    noInputSeconds: parseBoundedInt(data.noInputSeconds, 15, 5, 60, 'No input must be between 5 and 60 seconds.'),
    sorryLine: parseLine(data.sorryLine, 300, 'A sorry line can be at most 300 characters.'),
  };
}

function parseLine(value: unknown, max: number, message: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new BadRequestException(message);
  }
  return value.trim();
}

const MENU_KEY = /^[0-9]$/;

function parseMenuData(value: unknown): MenuNodeData {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (!Array.isArray(data.prompts) || data.prompts.length < 1 || data.prompts.length > 4) {
    throw new BadRequestException('A keypad menu needs 1 to 4 prompt lines.');
  }
  const prompts = data.prompts.map((item): MenuPrompt => {
    const prompt = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    return {
      ttsModelId: parseModelId(prompt.ttsModelId, 'Choose a text-to-speech model for each menu prompt.'),
      text: parseLine(prompt.text, 500, 'A menu prompt can be at most 500 characters.'),
    };
  });
  if (!Array.isArray(data.options) || data.options.length < 1 || data.options.length > 10) {
    throw new BadRequestException('A keypad menu needs 1 to 10 options.');
  }
  const options = data.options.map(parseMenuOption);
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const option of options) {
    if (ids.has(option.id)) throw new BadRequestException('Each menu option needs its own id.');
    ids.add(option.id);
    if (keys.has(option.key)) throw new BadRequestException(`Key ${option.key} is used by two menu options.`);
    keys.add(option.key);
  }
  if (typeof data.defaultOptionId !== 'string' || !ids.has(data.defaultOptionId)) {
    throw new BadRequestException('Choose the menu option used when no key is pressed.');
  }
  return {
    prompts,
    options,
    defaultOptionId: data.defaultOptionId,
    waitSeconds: parseBoundedInt(data.waitSeconds, 6, 2, 15, 'The wait for a key must be between 2 and 15 seconds.'),
    repeats: parseBoundedInt(data.repeats, 1, 0, 3, 'A menu can repeat 0 to 3 times.'),
  };
}

function parseMenuOption(value: unknown): MenuOption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('A menu option is invalid.');
  }
  const option = value as { id?: unknown; key?: unknown; label?: unknown };
  if (typeof option.id !== 'string' || !ID_PATTERN.test(option.id)) {
    throw new BadRequestException('A menu option has an invalid id.');
  }
  if (typeof option.key !== 'string' || !MENU_KEY.test(option.key)) {
    throw new BadRequestException('Each menu option needs a key from 0 to 9.');
  }
  return { id: option.id, key: option.key, label: parseLine(option.label, 80, 'A menu option label can be at most 80 characters.') };
}

function parseModelId(value: unknown, message: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !MODEL_ID.test(value)) {
    throw new BadRequestException(message);
  }
  return value;
}

function parseBoundedInt(value: unknown, fallback: number, min: number, max: number, message: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number.NaN;
  const rounded = Math.round(number);
  if (!Number.isFinite(number) || rounded < min || rounded > max) {
    throw new BadRequestException(message);
  }
  return rounded;
}

function parseFillers(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException('Delay lines must be a list.');
  }
  if (value.length > 8) {
    throw new BadRequestException('A conversational loop can have at most 8 delay lines.');
  }
  const fillers: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length > 200) {
      throw new BadRequestException('Each delay line can be at most 200 characters.');
    }
    const trimmed = item.trim();
    if (trimmed) fillers.push(trimmed);
  }
  return fillers;
}

function parseTtsData(value: unknown): { modelId: string | null; text: string } {
  const data =
    value && typeof value === 'object' && !Array.isArray(value) ? (value as { modelId?: unknown; text?: unknown }) : {};
  let modelId: string | null = null;
  if (data.modelId !== undefined && data.modelId !== null) {
    if (typeof data.modelId !== 'string' || !MODEL_ID.test(data.modelId)) {
      throw new BadRequestException('Choose a text-to-speech model.');
    }
    modelId = data.modelId;
  }
  const text = data.text === undefined ? '' : data.text;
  if (typeof text !== 'string' || text.length > 5000) {
    throw new BadRequestException('Text to speech can be at most 5000 characters.');
  }
  return { modelId, text };
}

function parseSwitchData(value: unknown): SwitchNodeData {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? (value as { topics?: unknown }) : {};
  if (!Array.isArray(data.topics) || data.topics.length < 1 || data.topics.length > 9) {
    throw new BadRequestException('A topic switch can have Default and at most 8 topics.');
  }
  const topics = data.topics.map(parseTopic);
  if (topics.filter((topic) => topic.isDefault).length !== 1) {
    throw new BadRequestException('A topic switch needs one Default.');
  }
  const ids = new Set<string>();
  for (const topic of topics) {
    if (ids.has(topic.id)) throw new BadRequestException('Each topic needs its own id.');
    ids.add(topic.id);
    if (!topic.isDefault && !topic.description) throw new BadRequestException('Describe each topic.');
  }
  const fallback = topics.find((topic) => topic.isDefault);
  const rest = topics.filter((topic) => !topic.isDefault);
  return { topics: fallback ? [fallback, ...rest] : topics };
}

function parseTopic(value: unknown): SwitchTopic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('A topic is invalid.');
  }
  const topic = value as { id?: unknown; description?: unknown; isDefault?: unknown };
  if (typeof topic.id !== 'string' || !ID_PATTERN.test(topic.id)) {
    throw new BadRequestException('A topic has an invalid id.');
  }
  const isDefault = topic.isDefault === true;
  if (topic.description !== undefined && typeof topic.description !== 'string') {
    throw new BadRequestException('Describe each topic.');
  }
  const description = isDefault || typeof topic.description !== 'string' ? '' : topic.description.trim();
  if (!isDefault && (description.length === 0 || description.length > 240)) {
    throw new BadRequestException('Describe each topic in 240 characters or less.');
  }
  return { id: topic.id, description, isDefault };
}

function assertTopicsReachEnd(nodes: ScenarioGraphNode[], edges: ScenarioGraphEdge[]) {
  for (const node of nodes) {
    if (node.type !== 'switch') continue;
    for (const topic of node.data.topics) {
      const edge = edges.find((item) => item.source === node.id && item.sourceHandle === topic.id);
      if (!edge) {
        const label = topic.isDefault ? 'Default' : `"${topic.description.slice(0, 80)}"`;
        throw new BadRequestException(`Connect ${label} through to End.`);
      }
      if (!leadsToEnd(edge.target, nodes, edges, new Set([node.id]))) {
        throw new BadRequestException('Every topic must lead to End.');
      }
    }
  }
}

function assertOptionsReachEnd(nodes: ScenarioGraphNode[], edges: ScenarioGraphEdge[]) {
  for (const node of nodes) {
    if (node.type !== 'menu') continue;
    for (const option of node.data.options) {
      const edge = edges.find((item) => item.source === node.id && item.sourceHandle === option.id);
      if (!edge) throw new BadRequestException(`Connect key ${option.key} through to End.`);
      if (!leadsToEnd(edge.target, nodes, edges, new Set([node.id]))) {
        throw new BadRequestException('Every menu option must lead to End.');
      }
    }
  }
}

function leadsToEnd(nodeId: string, nodes: ScenarioGraphNode[], edges: ScenarioGraphEdge[], seen: Set<string>): boolean {
  if (seen.has(nodeId)) return false;
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  if (node.type === 'end') return true;
  const nextSeen = new Set(seen);
  nextSeen.add(nodeId);
  const handles = branchHandles(node);
  if (handles) {
    return handles.every((handle) => {
      const edge = edges.find((item) => item.source === node.id && item.sourceHandle === handle);
      return edge ? leadsToEnd(edge.target, nodes, edges, nextSeen) : false;
    });
  }
  const outgoing = edges.filter((item) => item.source === nodeId);
  if (outgoing.length !== 1) return false;
  return leadsToEnd(outgoing[0].target, nodes, edges, nextSeen);
}

function parseEdge(value: unknown, nodes: ScenarioGraphNode[]): ScenarioGraphEdge {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('A scenario connection is invalid.');
  }
  const edge = value as { id?: unknown; source?: unknown; target?: unknown; sourceHandle?: unknown };
  if (typeof edge.id !== 'string' || !ID_PATTERN.test(edge.id)) {
    throw new BadRequestException('A scenario connection has an invalid id.');
  }
  if (typeof edge.source !== 'string' || typeof edge.target !== 'string') {
    throw new BadRequestException('A scenario connection is invalid.');
  }
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) {
    throw new BadRequestException('A connection points at a missing step.');
  }
  if (!CONNECTIONS[source.type].includes(target.type)) {
    throw new BadRequestException('Connect Start to Text to speech, Conversational Loop, or Keypad menu, then continue through to End.');
  }
  let sourceHandle: string | undefined;
  if (edge.sourceHandle !== undefined && edge.sourceHandle !== null) {
    if (typeof edge.sourceHandle !== 'string' || !ID_PATTERN.test(edge.sourceHandle)) {
      throw new BadRequestException('A topic connection is invalid.');
    }
    sourceHandle = edge.sourceHandle;
  }
  const handles = branchHandles(source);
  if (handles) {
    if (!sourceHandle || !handles.includes(sourceHandle)) {
      throw new BadRequestException(
        source.type === 'menu' ? 'Connect each menu option to its next step.' : 'Connect each topic to its next step.',
      );
    }
  } else if (sourceHandle) {
    throw new BadRequestException('Only a topic switch or a keypad menu chooses a direction.');
  }
  return sourceHandle
    ? { id: edge.id, source: edge.source, target: edge.target, sourceHandle }
    : { id: edge.id, source: edge.source, target: edge.target };
}
