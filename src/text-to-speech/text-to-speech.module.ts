import { Module } from '@nestjs/common';
import { ScenarioExecutionsModule } from '../scenario-executions/scenario-executions.module';
import { ElevenLabsTtsProvider } from './providers/elevenlabs.provider';
import { TtsProviderRegistry } from './providers/provider.registry';
import { TextToSpeechController } from './text-to-speech.controller';
import { TextToSpeechService } from './text-to-speech.service';

@Module({
  imports: [ScenarioExecutionsModule],
  controllers: [TextToSpeechController],
  providers: [TextToSpeechService, TtsProviderRegistry, ElevenLabsTtsProvider],
  exports: [TextToSpeechService],
})
export class TextToSpeechModule {}
