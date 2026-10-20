import { BadRequestException } from '@nestjs/common';
import { LANGUAGE_NAME, ScenarioLanguage, isScenarioLanguage } from './scenario-languages';

export const SCENARIO_NODE_TYPES = ['start', 'end', 'tts', 'loop', 'switch', 'closing'] as const;

export const CLOSING_HANDLES = ['questions', 'done'] as const;

export const CLOSING_QUESTION = 'Do you have other questions?';

export type ScenarioNodeType = (typeof SCENARIO_NODE_TYPES)[number];

export interface TtsNodeData {
  modelId: string | null;
  text?: string;
  texts?: Partial<Record<ScenarioLanguage, string>>;
}

export interface LoopNodeData {
  sttModelId: string | null;
  ttsModelId: string | null;
  llmModelId: string | null;
  silenceSeconds: number;
  fillers?: string[];
  fillerTexts?: Partial<Record<ScenarioLanguage, string[]>>;
  maxTurns: number;
}

export interface SwitchTopic {
  id: string;
  description: string;
  isDefault: boolean;
}

export interface SwitchNodeData {
  topics: SwitchTopic[];
}

export interface ClosingNodeData {
  sttModelId: string | null;
  ttsModelId: string | null;
  llmModelId: string | null;
  silenceSeconds: number;
  text?: string;
  texts?: Partial<Record<ScenarioLanguage, string>>;
}

export type ScenarioGraphNode =
  | { id: string; type: 'start' | 'end'; position: { x: number; y: number }; data: Record<string, never> }
  | { id: string; type: 'tts'; position: { x: number; y: number }; data: TtsNodeData }
  | { id: string; type: 'loop'; position: { x: number; y: number }; data: LoopNodeData }
  | { id: string; type: 'switch'; position: { x: number; y: number }; data: SwitchNodeData }
  | { id: string; type: 'closing'; position: { x: number; y: number }; data: ClosingNodeData };

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
  start: ['tts', 'loop', 'closing'],
  end: [],
  tts: ['tts', 'loop', 'switch', 'closing', 'end'],
  loop: ['tts', 'loop', 'switch', 'closing', 'end'],
  switch: ['tts', 'loop', 'switch', 'closing', 'end'],
  closing: ['tts', 'loop', 'switch', 'closing', 'end'],
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export function emptyScenarioGraph(): ScenarioGraph {
  return { nodes: [], edges: [] };
}

export function parseScenarioGraph(input: unknown, languages?: ScenarioLanguage[]): ScenarioGraph {
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

  const nodes = record.nodes.map((node) => parseNode(node, languages));
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
      if (topicLanes.has(lane)) throw new BadRequestException('A topic can lead to only one next step.');
      topicLanes.add(lane);
    }
  }
  assertTopicsReachEnd(nodes, edges);
  assertClosingRoutes(nodes, edges);

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

function parseNode(value: unknown, languages?: ScenarioLanguage[]): ScenarioGraphNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('A scenario step is invalid.');
  }
  const node = value as { id?: unknown; type?: unknown; position?: unknown; data?: unknown };
  if (typeof node.id !== 'string' || !ID_PATTERN.test(node.id)) {
    throw new BadRequestException('A scenario step has an invalid id.');
  }
  if (node.type !== 'start' && node.type !== 'end' && node.type !== 'tts' && node.type !== 'loop' && node.type !== 'switch' && node.type !== 'closing') {
    throw new BadRequestException('A scenario step has an unknown type.');
  }
  const position = parsePosition(node.position);
  if (node.type === 'tts') {
    return { id: node.id, type: node.type, position, data: parseTtsData(node.data, languages) };
  }
  if (node.type === 'loop') {
    return { id: node.id, type: node.type, position, data: parseLoopData(node.data, languages) };
  }
  if (node.type === 'switch') {
    return { id: node.id, type: node.type, position, data: parseSwitchData(node.data) };
  }
  if (node.type === 'closing') {
    return { id: node.id, type: node.type, position, data: parseClosingData(node.data, languages) };
  }
  return { id: node.id, type: node.type, position, data: {} };
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

function parseLoopData(value: unknown, languages?: ScenarioLanguage[]): LoopNodeData {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const shared = {
    sttModelId: parseModelId(data.sttModelId, 'Choose a speech-to-text model.'),
    ttsModelId: parseModelId(data.ttsModelId, 'Choose a text-to-speech model.'),
    llmModelId: parseModelId(data.llmModelId, 'Choose an LLM.'),
    silenceSeconds: parseBoundedInt(data.silenceSeconds, 4, 1, 30, 'Silence must be between 1 and 30 seconds.'),
    maxTurns: parseBoundedInt(data.maxTurns, 8, 1, 20, 'Max turns must be between 1 and 20.'),
  };
  if (languages && languages.length > 0) {
    return { ...shared, fillerTexts: requireFillerTexts(data.fillerTexts, languages) };
  }
  const fillerTexts = optionalFillerTexts(data.fillerTexts);
  return { ...shared, fillers: parseFillers(data.fillers), ...(fillerTexts ? { fillerTexts } : {}) };
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

function parseTtsData(value: unknown, languages?: ScenarioLanguage[]): TtsNodeData {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const modelId = parseModelId(data.modelId, 'Choose a text-to-speech model.');
  if (languages && languages.length > 0) {
    return { modelId, texts: requireSpoken(data.texts, languages, 5000, 'text to speech') };
  }
  const texts = optionalSpoken(data.texts, 5000, 'Text to speech');
  const text = data.text === undefined ? '' : data.text;
  if (typeof text !== 'string' || text.length > 5000) {
    throw new BadRequestException('Text to speech can be at most 5000 characters.');
  }
  return texts ? { modelId, text, texts } : { modelId, text };
}

function parseClosingData(value: unknown, languages?: ScenarioLanguage[]): ClosingNodeData {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const shared = {
    sttModelId: parseModelId(data.sttModelId, 'Choose a speech-to-text model.'),
    ttsModelId: parseModelId(data.ttsModelId, 'Choose a text-to-speech model.'),
    llmModelId: parseModelId(data.llmModelId, 'Choose an LLM.'),
    silenceSeconds: parseBoundedInt(data.silenceSeconds, 4, 1, 30, 'Silence must be between 1 and 30 seconds.'),
  };
  if (languages && languages.length > 0) {
    return { ...shared, texts: requireSpoken(data.texts, languages, 500, 'closing question') };
  }
  const text = data.text === undefined ? CLOSING_QUESTION : data.text;
  if (typeof text !== 'string' || text.length > 500) {
    throw new BadRequestException('The closing question can be at most 500 characters.');
  }
  const texts = optionalSpoken(data.texts, 500, 'The closing question');
  return texts ? { ...shared, text, texts } : { ...shared, text };
}

function requireSpoken(value: unknown, languages: ScenarioLanguage[], max: number, label: string) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const texts = {} as Record<ScenarioLanguage, string>;
  for (const language of languages) {
    const line = source[language];
    if (typeof line !== 'string' || !line.trim()) {
      throw new BadRequestException(`Write the ${LANGUAGE_NAME[language]} ${label}.`);
    }
    if (line.length > max) throw new BadRequestException(`The ${LANGUAGE_NAME[language]} ${label} is too long.`);
    texts[language] = line.trim();
  }
  return texts;
}

function optionalSpoken(value: unknown, max: number, label: string) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${label} translations are invalid.`);
  }
  const texts: Partial<Record<ScenarioLanguage, string>> = {};
  for (const [code, line] of Object.entries(value)) {
    if (!isScenarioLanguage(code) || typeof line !== 'string' || line.length > max) {
      throw new BadRequestException(`${label} translations are invalid.`);
    }
    if (line.trim()) texts[code] = line.trim();
  }
  return texts;
}

function requireFillerTexts(value: unknown, languages: ScenarioLanguage[]) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const texts = {} as Record<ScenarioLanguage, string[]>;
  for (const language of languages) {
    const lines = parseFillers(source[language] ?? []);
    if (lines.length === 0) throw new BadRequestException(`Write the ${LANGUAGE_NAME[language]} delay lines.`);
    texts[language] = lines;
  }
  return texts;
}

function optionalFillerTexts(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Delay line translations are invalid.');
  }
  const texts: Partial<Record<ScenarioLanguage, string[]>> = {};
  for (const [code, lines] of Object.entries(value)) {
    if (!isScenarioLanguage(code)) throw new BadRequestException('Delay line translations are invalid.');
    const parsed = parseFillers(lines);
    if (parsed.length > 0) texts[code] = parsed;
  }
  return texts;
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

function assertClosingRoutes(nodes: ScenarioGraphNode[], edges: ScenarioGraphEdge[]) {
  for (const node of nodes) {
    if (node.type !== 'closing') continue;
    const questions = edges.find((item) => item.source === node.id && item.sourceHandle === 'questions');
    const done = edges.find((item) => item.source === node.id && item.sourceHandle === 'done');
    if (!questions) throw new BadRequestException('Connect Still has questions.');
    if (!done) throw new BadRequestException('Connect No more questions through to End.');
    if (!leadsToEnd(done.target, nodes, edges, new Set([node.id]))) {
      throw new BadRequestException('No more questions must lead to End.');
    }
  }
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

function leadsToEnd(nodeId: string, nodes: ScenarioGraphNode[], edges: ScenarioGraphEdge[], seen: Set<string>): boolean {
  if (seen.has(nodeId)) return false;
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  if (node.type === 'end') return true;
  const nextSeen = new Set(seen);
  nextSeen.add(nodeId);
  if (node.type === 'switch') {
    return node.data.topics.every((topic) => {
      const edge = edges.find((item) => item.source === node.id && item.sourceHandle === topic.id);
      return edge ? leadsToEnd(edge.target, nodes, edges, nextSeen) : false;
    });
  }
  if (node.type === 'closing') {
    const edge = edges.find((item) => item.source === node.id && item.sourceHandle === 'done');
    return edge ? leadsToEnd(edge.target, nodes, edges, nextSeen) : false;
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
    throw new BadRequestException('Connect Start to Text to speech, Conversational loop, or Closing, then continue through to End.');
  }
  let sourceHandle: string | undefined;
  if (edge.sourceHandle !== undefined && edge.sourceHandle !== null) {
    if (typeof edge.sourceHandle !== 'string' || !ID_PATTERN.test(edge.sourceHandle)) {
      throw new BadRequestException('A topic connection is invalid.');
    }
    sourceHandle = edge.sourceHandle;
  }
  if (source.type === 'switch') {
    if (!sourceHandle || !source.data.topics.some((topic) => topic.id === sourceHandle)) {
      throw new BadRequestException('Connect each topic to its next step.');
    }
  } else if (source.type === 'closing') {
    if (sourceHandle !== 'questions' && sourceHandle !== 'done') {
      throw new BadRequestException('Connect Still has questions and No more questions.');
    }
  } else if (sourceHandle) {
    throw new BadRequestException('Only a topic switch or a closing step chooses a direction.');
  }
  return sourceHandle
    ? { id: edge.id, source: edge.source, target: edge.target, sourceHandle }
    : { id: edge.id, source: edge.source, target: edge.target };
}
