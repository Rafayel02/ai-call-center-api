import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { ScenarioExecutionsModule } from '../scenario-executions/scenario-executions.module';
import { ScenariosModule } from '../scenarios/scenarios.module';
import { SpeechToTextModule } from '../speech-to-text/speech-to-text.module';
import { TextToSpeechModule } from '../text-to-speech/text-to-speech.module';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';

@Module({
  imports: [ScenariosModule, ScenarioExecutionsModule, SpeechToTextModule, TextToSpeechModule, LlmModule],
  controllers: [CallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
