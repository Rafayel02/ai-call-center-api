import { Module } from '@nestjs/common';
import { CallsModule } from '../calls/calls.module';
import { TelephonyController } from './telephony.controller';
import { TelephonyService } from './telephony.service';

@Module({
  imports: [CallsModule],
  controllers: [TelephonyController],
  providers: [TelephonyService],
  exports: [TelephonyService],
})
export class TelephonyModule {}
