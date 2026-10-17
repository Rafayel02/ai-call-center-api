import { BadRequestException } from '@nestjs/common';

export const SCENARIO_NODE_TYPES = ['start', 'end', 'tts', 'loop'] as const;

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
}

export type ScenarioGraphNode =
  | { id: string; type: 'start' | 'end'; position: { x: number; y: number }; data: Record<string, never> }
  | { id: string; type: 'tts'; position: { x: number; y: number }; data: TtsNodeData }
  | { id: string; type: 'loop'; position: { x: number; y: number }; data: LoopNodeData };

export interface ScenarioGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface ScenarioGraph {
  nodes: ScenarioGraphNode[];
  edges: ScenarioGraphEdge[];
}

const CONNECTIONS: Record<ScenarioNodeType, readonly ScenarioNodeType[]> = {
  start: ['tts', 'loop'],
  end: [],
  tts: ['tts', 'loop', 'end'],
  loop: ['tts', 'loop', 'end'],
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

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
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) throw new BadRequestException('Each connection needs its own id.');
    edgeIds.add(edge.id);
    const pair = `${edge.source}>${edge.target}`;
    if (pairs.has(pair)) throw new BadRequestException('Those steps are already connected.');
    pairs.add(pair);
  }

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
  if (node.type !== 'start' && node.type !== 'end' && node.type !== 'tts' && node.type !== 'loop') {
    throw new BadRequestException('A scenario step has an unknown type.');
  }
  const position = parsePosition(node.position);
  if (node.type === 'tts') {
    return { id: node.id, type: node.type, position, data: parseTtsData(node.data) };
  }
  if (node.type === 'loop') {
    return { id: node.id, type: node.type, position, data: parseLoopData(node.data) };
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

function parseLoopData(value: unknown): LoopNodeData {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    sttModelId: parseModelId(data.sttModelId, 'Choose a speech-to-text model.'),
    ttsModelId: parseModelId(data.ttsModelId, 'Choose a text-to-speech model.'),
    llmModelId: parseModelId(data.llmModelId, 'Choose an LLM.'),
    silenceSeconds: parseBoundedInt(data.silenceSeconds, 4, 1, 30, 'Silence must be between 1 and 30 seconds.'),
    fillers: parseFillers(data.fillers),
    maxTurns: parseBoundedInt(data.maxTurns, 8, 1, 20, 'Max turns must be between 1 and 20.'),
  };
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

function parseEdge(value: unknown, nodes: ScenarioGraphNode[]): ScenarioGraphEdge {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('A scenario connection is invalid.');
  }
  const edge = value as { id?: unknown; source?: unknown; target?: unknown };
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
    throw new BadRequestException('Connect Start to Text to speech or Conversational Loop, then continue through to End.');
  }
  return { id: edge.id, source: edge.source, target: edge.target };
}
