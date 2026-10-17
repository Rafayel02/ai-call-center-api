import { BadRequestException, Injectable } from '@nestjs/common';
import { LlmProvider } from '@prisma/client';
import { LlmProviderClient } from './llm-provider';
import { OpenAiProvider } from './openai.provider';

@Injectable()
export class ProviderRegistry {
  private readonly providers: Map<LlmProvider, LlmProviderClient>;

  constructor(openAi: OpenAiProvider) {
    this.providers = new Map<LlmProvider, LlmProviderClient>([[openAi.id, openAi]]);
  }

  get(provider: LlmProvider): LlmProviderClient {
    const implementation = this.providers.get(provider);
    if (!implementation) {
      throw new BadRequestException('That LLM provider is not available.');
    }
    return implementation;
  }

  list() {
    return [...this.providers.values()].map((provider) => ({ id: provider.id }));
  }
}
