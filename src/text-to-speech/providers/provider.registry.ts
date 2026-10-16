import { BadRequestException, Injectable } from '@nestjs/common';
import { TtsProvider } from '@prisma/client';
import { ElevenLabsTtsProvider } from './elevenlabs.provider';
import { TextToSpeechProvider } from './text-to-speech-provider';

@Injectable()
export class TtsProviderRegistry {
  private readonly providers: Map<TtsProvider, TextToSpeechProvider>;

  constructor(elevenLabs: ElevenLabsTtsProvider) {
    this.providers = new Map<TtsProvider, TextToSpeechProvider>([[elevenLabs.id, elevenLabs]]);
  }

  get(provider: TtsProvider): TextToSpeechProvider {
    const implementation = this.providers.get(provider);
    if (!implementation) throw new BadRequestException('That text-to-speech provider is not available.');
    return implementation;
  }

  list() {
    return [...this.providers.values()].map((provider) => ({ id: provider.id }));
  }
}
