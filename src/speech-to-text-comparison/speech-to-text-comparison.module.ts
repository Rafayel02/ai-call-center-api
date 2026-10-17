import { Module } from '@nestjs/common';
import { SpeechToTextModule } from '../speech-to-text/speech-to-text.module';
import { SpeechToTextComparisonController } from './speech-to-text-comparison.controller';
import { SpeechToTextComparisonService } from './speech-to-text-comparison.service';

@Module({
  imports: [SpeechToTextModule],
  controllers: [SpeechToTextComparisonController],
  providers: [SpeechToTextComparisonService],
})
export class SpeechToTextComparisonModule {}
