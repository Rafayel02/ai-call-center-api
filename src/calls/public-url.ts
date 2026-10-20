import { ConfigService } from '@nestjs/config';

export const BROWSER_STREAM_PATH = '/calls/browser/stream';
export const TWILIO_STREAM_PATH = '/telephony/twilio/stream';

/** The API's public origin. Twilio signs requests against it, and call streams are opened on it. */
export function publicBaseUrl(config: ConfigService) {
  const configured = config.get<string>('PUBLIC_BASE_URL')?.trim().replace(/\/+$/, '');
  return configured || `http://localhost:${config.get<string>('PORT') ?? '3001'}`;
}

export function publicStreamUrl(config: ConfigService, path: string) {
  return `${publicBaseUrl(config).replace(/^http/, 'ws')}${path}`;
}
