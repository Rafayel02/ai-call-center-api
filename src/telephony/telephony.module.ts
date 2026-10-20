import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { ScenarioExecutionsModule } from '../scenario-executions/scenario-executions.module';
import { PhoneStreamingModule } from '../phone-streaming/phone-streaming.module';
import { SpeechToTextModule } from '../speech-to-text/speech-to-text.module';
import { TextToSpeechModule } from '../text-to-speech/text-to-speech.module';
import { TelephonyController } from './telephony.controller';
import { TelephonyService } from './telephony.service';

@Module({
  imports: [PhoneStreamingModule, TextToSpeechModule, SpeechToTextModule, LlmModule, ScenarioExecutionsModule],
  controllers: [TelephonyController],
  providers: [TelephonyService],
  exports: [TelephonyService],
})
export class TelephonyModule {}
