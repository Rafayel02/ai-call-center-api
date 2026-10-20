import { Module } from '@nestjs/common';
import { ModelPricingController } from './model-pricing.controller';
import { ModelPricingService } from './model-pricing.service';

@Module({
  controllers: [ModelPricingController],
  providers: [ModelPricingService],
  exports: [ModelPricingService],
})
export class ModelPricingModule {}
