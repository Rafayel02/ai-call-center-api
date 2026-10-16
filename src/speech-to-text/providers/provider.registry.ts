import { BadRequestException, Injectable } from '@nestjs/common';
import { SttProvider } from '@prisma/client';
import { ElevenLabsProvider } from './elevenlabs.provider';
import { SpeechToTextProvider } from './speech-to-text-provider';

@Injectable()
export class ProviderRegistry {
  private readonly providers: Map<SttProvider, SpeechToTextProvider>;

  constructor(elevenLabs: ElevenLabsProvider) {
    this.providers = new Map([[elevenLabs.id, elevenLabs]]);
  }

  get(provider: SttProvider): SpeechToTextProvider {
    const implementation = this.providers.get(provider);
    if (!implementation) {
      throw new BadRequestException('That speech-to-text provider is not available.');
    }
    return implementation;
  }

  list() {
    return [...this.providers.values()].map((provider) => ({ id: provider.id }));
  }
}
