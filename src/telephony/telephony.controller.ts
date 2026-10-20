import { Body, Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { formParams } from './twilio-signature';
import { TelephonyService } from './telephony.service';

/** Webhooks Twilio calls. They carry no session cookie; the Twilio signature is their only credential. */
@SkipThrottle()
@Controller('telephony/twilio')
export class TelephonyController {
  constructor(private readonly telephony: TelephonyService) {}

  @Post('voice')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml; charset=utf-8')
  voice(@Req() request: { originalUrl: string; headers: Record<string, string | string[] | undefined> }, @Body() body: Record<string, unknown>) {
    const header = request.headers['x-twilio-signature'];
    return this.telephony.answer({
      path: request.originalUrl,
      params: formParams(body),
      signature: Array.isArray(header) ? header[0] : header,
    });
  }
}
