import { LlmProvider } from '@prisma/client';
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

export interface LlmCompletionRequest {
  messages: ConversationMessage[];
  note?: string;
  topics?: RouteTopic[];
  defaultTopicId?: string;
  verify?: boolean;
}

export interface LlmRouteRequest {
  inquiry?: string;
  messages: ConversationMessage[];
  topics: RouteTopic[];
  defaultTopicId: string;
}

export interface LlmProviderClient {
  readonly id: LlmProvider;
  readonly supportsConnectionTest: boolean;
  validateCreate(config: unknown): Record<string, unknown>;
  validateUpdate(config: unknown, existing: Record<string, unknown>): Record<string, unknown>;
  toPublic(config: Record<string, unknown>): PublicLlmConfig;
  test?(config: Record<string, unknown>): Promise<ConnectionTestResult>;
  complete(config: Record<string, unknown>, request: LlmCompletionRequest): Promise<InquiryTurn>;
  route(config: Record<string, unknown>, request: LlmRouteRequest): Promise<{ topicId: string }>;
}
