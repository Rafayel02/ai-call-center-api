import { Module } from '@nestjs/common';
import { PhoneStreamingController } from './phone-streaming.controller';
import { PhoneStreamingService } from './phone-streaming.service';

@Module({
  controllers: [PhoneStreamingController],
  providers: [PhoneStreamingService],
  exports: [PhoneStreamingService],
})
export class PhoneStreamingModule {}
