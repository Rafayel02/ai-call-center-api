import { Module } from '@nestjs/common';
import { DemoRequestsController } from './demo-requests.controller';
import { DemoRequestsService } from './demo-requests.service';

@Module({
  controllers: [DemoRequestsController],
  providers: [DemoRequestsService],
})
export class DemoRequestsModule {}
