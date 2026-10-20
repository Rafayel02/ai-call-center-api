import { Module } from '@nestjs/common';
import { ScenarioExecutionsModule } from '../scenario-executions/scenario-executions.module';
import { LlmController } from './llm.controller';
import { LlmService } from './llm.service';
import { OpenAiProvider } from './providers/openai.provider';
import { ProviderRegistry } from './providers/provider.registry';

@Module({
  imports: [ScenarioExecutionsModule],
  controllers: [LlmController],
  providers: [LlmService, ProviderRegistry, OpenAiProvider],
  exports: [LlmService],
})
export class LlmModule {}
