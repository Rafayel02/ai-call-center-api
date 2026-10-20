import { LlmProvider } from '@prisma/client';
import { ClosingOutcome } from '../closing-choice';
import { ConversationMessage, InquiryTurn } from '../inquiry-turn';
import { RouteTopic } from '../topic-route';

export interface PublicLlmConfig {
  modelId: string;
  apiKeyHint: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmCallTrace {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  raw: unknown;
  usage: LlmUsage | null;
  latencyMs: number;
}

export interface LlmCompletionResult {
  turn: InquiryTurn;
  trace: LlmCallTrace;
}

export class LlmCompletionError extends Error {
  readonly trace: LlmCallTrace;

  constructor(message: string, trace: LlmCallTrace) {
    super(message);
    this.name = 'LlmCompletionError';
    this.trace = trace;
  }
}

export interface LlmCompletionRequest {
  messages: ConversationMessage[];
  note?: string;
  topics?: RouteTopic[];
  defaultTopicId?: string;
  closingReturn?: boolean;
}

export interface LlmRouteRequest {
  inquiry?: string;
  messages: ConversationMessage[];
  topics: RouteTopic[];
  defaultTopicId: string;
}

export interface LlmClosingRequest {
  question: string;
  answer: string;
}

export interface LlmClosingResult {
  outcome: ClosingOutcome;
  trace: LlmCallTrace;
}

export interface LlmProviderClient {
  readonly id: LlmProvider;
  readonly supportsConnectionTest: boolean;
  validateCreate(config: unknown): Record<string, unknown>;
  validateUpdate(config: unknown, existing: Record<string, unknown>): Record<string, unknown>;
  toPublic(config: Record<string, unknown>): PublicLlmConfig;
  test?(config: Record<string, unknown>): Promise<ConnectionTestResult>;
  complete(config: Record<string, unknown>, request: LlmCompletionRequest, signal?: AbortSignal): Promise<LlmCompletionResult>;
  route(config: Record<string, unknown>, request: LlmRouteRequest): Promise<{ topicId: string }>;
  judgeClosing(config: Record<string, unknown>, request: LlmClosingRequest, signal?: AbortSignal): Promise<LlmClosingResult>;
}
