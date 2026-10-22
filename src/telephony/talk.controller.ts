import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { TelephonyService } from './telephony.service';

@Controller('telephony')
export class TalkController {
  constructor(private readonly telephony: TelephonyService) {}

  @Post('talk-token')
  @UseGuards(JwtAuthGuard)
  token(@CurrentUser() user: AuthUser) {
    return { token: this.telephony.talkToken(user.id) };
  }
}
