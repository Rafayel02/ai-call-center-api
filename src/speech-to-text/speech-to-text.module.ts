import { Module } from '@nestjs/common';
import { ElevenLabsProvider } from './providers/elevenlabs.provider';
import { HiSpeechProvider } from './providers/hispeech.provider';
import { ProviderRegistry } from './providers/provider.registry';
import { SpeechToTextController } from './speech-to-text.controller';
import { SpeechToTextService } from './speech-to-text.service';

@Module({
  controllers: [SpeechToTextController],
  providers: [SpeechToTextService, ProviderRegistry, ElevenLabsProvider, HiSpeechProvider],
})
export class SpeechToTextModule {}
