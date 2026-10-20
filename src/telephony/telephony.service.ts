import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IncomingMessage } from 'node:http';
import { CallsService } from '../calls/calls.service';
import { publicBaseUrl, publicStreamUrl, TWILIO_STREAM_PATH } from '../calls/public-url';
import { isTwilioSignature } from './twilio-signature';

/** Twilio's side of a phone call: the signed voice webhook and the signed media stream handshake. */
@Injectable()
export class TelephonyService {
  private readonly logger = new Logger(TelephonyService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly calls: CallsService,
  ) {}

  /** Answers `POST /telephony/twilio/voice` with TwiML. */
  async answer(input: { path: string; params: Record<string, string>; signature: string | undefined }) {
    const authToken = this.authToken();
    if (!authToken) throw new ServiceUnavailableException('Set TWILIO_AUTH_TOKEN on the API before taking phone calls.');
    // Twilio signs the URL it was given, which is the public one, not the address the request arrives at here.
    const url = `${publicBaseUrl(this.config)}${input.path}`;
    if (!isTwilioSignature(authToken, [url], input.params, input.signature)) {
      this.logger.warn(`Refused a voice webhook with a bad Twilio signature for ${url}`);
      throw new ForbiddenException('The Twilio signature is not valid.');
    }
    const callSid = input.params.CallSid?.trim();
    const to = input.params.To?.trim();
    if (!callSid || !to) throw new ForbiddenException('The request is missing CallSid or To.');
    return this.calls.answerPhoneCall({ callSid, to, from: input.params.From?.trim() || null });
  }

  /** Twilio signs the media stream handshake too. Its docs say to also try the URL with a trailing slash. */
  verifyStreamHandshake(request: IncomingMessage) {
    const authToken = this.authToken();
    if (!authToken) return false;
    const header = request.headers['x-twilio-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    const streamUrl = publicStreamUrl(this.config, TWILIO_STREAM_PATH);
    const urls = [streamUrl, `${streamUrl}/`, streamUrl.replace(/^ws/, 'http'), `${streamUrl.replace(/^ws/, 'http')}/`];
    return isTwilioSignature(authToken, urls, {}, signature);
  }

  private authToken() {
    return this.config.get<string>('TWILIO_AUTH_TOKEN')?.trim() || null;
  }
}
