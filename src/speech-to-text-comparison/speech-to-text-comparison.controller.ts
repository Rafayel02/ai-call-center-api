import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PreviewComparisonDto, RunCheckDto } from './dto/comparison.dto';
import { SpeechToTextComparisonService } from './speech-to-text-comparison.service';

@Controller('speech-to-text-comparison')
@UseGuards(JwtAuthGuard)
export class SpeechToTextComparisonController {
  constructor(private readonly comparison: SpeechToTextComparisonService) {}

  @Post('preview')
  preview(@Body() dto: PreviewComparisonDto) {
    return this.comparison.preview(dto);
  }

  @Post('check')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  check(@Body() dto: RunCheckDto) {
    return this.comparison.check(dto);
  }
}
