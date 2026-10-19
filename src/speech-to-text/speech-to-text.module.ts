import { Module } from '@nestjs/common';
import { ScenarioExecutionsModule } from '../scenario-executions/scenario-executions.module';
import { ElevenLabsProvider } from './providers/elevenlabs.provider';
import { HiSpeechProvider } from './providers/hispeech.provider';
import { ProviderRegistry } from './providers/provider.registry';
import { SpeechToTextController } from './speech-to-text.controller';
import { SpeechToTextService } from './speech-to-text.service';

@Module({
  imports: [ScenarioExecutionsModule],
  controllers: [SpeechToTextController],
  providers: [SpeechToTextService, ProviderRegistry, ElevenLabsProvider, HiSpeechProvider],
  exports: [ProviderRegistry, SpeechToTextService],
})
export class SpeechToTextModule {}
