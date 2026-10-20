import { Module } from '@nestjs/common';
import { ModelPricingModule } from '../model-pricing/model-pricing.module';
import { ScenarioExecutionsController } from './scenario-executions.controller';
import { ScenarioExecutionsService } from './scenario-executions.service';

@Module({
  imports: [ModelPricingModule],
  controllers: [ScenarioExecutionsController],
  providers: [ScenarioExecutionsService],
  exports: [ScenarioExecutionsService],
})
export class ScenarioExecutionsModule {}
