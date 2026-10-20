import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ModelPricingService } from './model-pricing.service';

@Controller('model-pricing')
@UseGuards(JwtAuthGuard)
export class ModelPricingController {
  constructor(private readonly pricing: ModelPricingService) {}

  @Get()
  current() {
    return this.pricing.current();
  }
}
