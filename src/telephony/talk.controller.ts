import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { Request } from 'express';
import { TelephonyService } from './telephony.service';

@Controller('telephony')
export class TalkController {
  constructor(private readonly telephony: TelephonyService) {}

  @Post('talk-token')
  @UseGuards(JwtAuthGuard)
  token(@CurrentUser() user: AuthUser, @Req() request: Request & { demoScenarioId?: string }) {
    return { token: this.telephony.talkToken(user.id, request.demoScenarioId) };
  }
}
