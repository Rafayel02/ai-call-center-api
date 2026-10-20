import { Injectable, Logger } from '@nestjs/common';
import { HiSpeechRate, MeteredRate, TokenRate, readElevenLabsPrices, readElevenLabsRates, readHiSpeechPrice, readHiSpeechRate, readOpenAiPrices, readOpenAiRates } from './read-prices';

const OPENAI_PRICING_URL = 'https://developers.openai.com/api/docs/pricing.md';
const ELEVENLABS_PRICING_URL = 'https://elevenlabs.io/pricing/api';
const HISPEECH_PRICING_URL = 'https://hispeech.ai/en/';

export interface ModelPriceCatalog {
  openai: Record<string, string>;
  elevenlabs: Record<string, string>;
  hispeech: string | null;
}

export interface PriceCatalog {
  openai: Record<string, TokenRate> | null;
  elevenlabs: Record<string, MeteredRate> | null;
  hispeech: HiSpeechRate | null;
}

@Injectable()
export class ModelPricingService {
  private readonly logger = new Logger(ModelPricingService.name);

  async current(): Promise<ModelPriceCatalog> {
    const [openai, elevenlabs, hispeech] = await Promise.all([
      this.load('OpenAI', OPENAI_PRICING_URL, readOpenAiPrices, {}),
      this.load('ElevenLabs', ELEVENLABS_PRICING_URL, readElevenLabsPrices, {}),
      this.load('HiSpeech', HISPEECH_PRICING_URL, readHiSpeechPrice, null),
    ]);
    return { openai, elevenlabs, hispeech };
  }

  rates(): Promise<PriceCatalog> {
    return Promise.all([
      this.load('OpenAI', OPENAI_PRICING_URL, readOpenAiRates, null),
      this.load('ElevenLabs', ELEVENLABS_PRICING_URL, readElevenLabsRates, null),
      this.load('HiSpeech', HISPEECH_PRICING_URL, readHiSpeechRate, null),
    ]).then(([openai, elevenlabs, hispeech]) => ({ openai, elevenlabs, hispeech }));
  }

  private async load<T>(name: string, url: string, read: (body: string) => T, fallback: T): Promise<T> {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/markdown, text/html, text/plain', 'User-Agent': 'ai-call-center' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error(String(response.status));
      return read(await response.text());
    } catch (error) {
      this.logger.warn(`Could not read ${name} pricing: ${error instanceof Error ? error.message : 'unknown error'}`);
      return fallback;
    }
  }
}
