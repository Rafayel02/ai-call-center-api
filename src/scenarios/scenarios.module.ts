import { Module } from '@nestjs/common';
import { TextToSpeechModule } from '../text-to-speech/text-to-speech.module';
import { ScenariosController } from './scenarios.controller';
import { ScenariosService } from './scenarios.service';

@Module({
  imports: [TextToSpeechModule],
  controllers: [ScenariosController],
  providers: [ScenariosService],
  exports: [ScenariosService],
})
export class ScenariosModule {}
