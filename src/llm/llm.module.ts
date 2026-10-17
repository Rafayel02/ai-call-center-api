import { Module } from '@nestjs/common';
import { LlmController } from './llm.controller';
import { LlmService } from './llm.service';
import { OpenAiProvider } from './providers/openai.provider';
import { ProviderRegistry } from './providers/provider.registry';

@Module({
  controllers: [LlmController],
  providers: [LlmService, ProviderRegistry, OpenAiProvider],
})
export class LlmModule {}
