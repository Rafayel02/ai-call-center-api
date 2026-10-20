import { Body, Controller, Get, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { publicOrigin } from './public-origin';
import { TelephonyService } from './telephony.service';
import { formParams } from './twilio-signature';

/** Twilio posts here with no session cookie. The signature is the credential. */
@Controller('telephony/twilio')
export class TelephonyController {
  constructor(private readonly telephony: TelephonyService) {}

  @Post('voice')
  @SkipThrottle()
  @HttpCode(200)
  @Header('Content-Type', 'text/xml; charset=utf-8')
  voice(@Req() request: { originalUrl: string; headers: Record<string, string | string[] | undefined> }, @Body() body: Record<string, unknown>) {
    const header = request.headers['x-twilio-signature'];
    return this.telephony.answer({
      origin: publicOrigin(request.headers),
      path: request.originalUrl,
      params: formParams(body),
      signature: Array.isArray(header) ? header[0] : header,
    });
  }

  @Get('setup')
  @UseGuards(JwtAuthGuard)
  setup(@Req() request: { headers: Record<string, string | string[] | undefined> }) {
    return { webhookUrl: `${publicOrigin(request.headers)}/telephony/twilio/voice` };
  }

  @Get('calls')
  @UseGuards(JwtAuthGuard)
  calls() {
    return this.telephony.list();
  }
}
