import { LlmProvider } from '@prisma/client';
import { ConversationMessage, InquiryTurn } from '../inquiry-turn';

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
}

export interface LlmProviderClient {
  readonly id: LlmProvider;
  readonly supportsConnectionTest: boolean;
  validateCreate(config: unknown): Record<string, unknown>;
  validateUpdate(config: unknown, existing: Record<string, unknown>): Record<string, unknown>;
  toPublic(config: Record<string, unknown>): PublicLlmConfig;
  test?(config: Record<string, unknown>): Promise<ConnectionTestResult>;
  complete(config: Record<string, unknown>, request: LlmCompletionRequest): Promise<InquiryTurn>;
}
