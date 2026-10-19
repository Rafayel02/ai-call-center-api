import { Module } from '@nestjs/common';
import { ScenarioExecutionsController } from './scenario-executions.controller';
import { ScenarioExecutionsService } from './scenario-executions.service';

@Module({
  controllers: [ScenarioExecutionsController],
  providers: [ScenarioExecutionsService],
  exports: [ScenarioExecutionsService],
})
export class ScenarioExecutionsModule {}
