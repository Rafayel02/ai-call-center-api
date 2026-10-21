import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DemoRequestsService } from './demo-requests.service';
import { CreateDemoRequestDto } from './dto/create-demo-request.dto';

@Controller('demo-requests')
export class DemoRequestsController {
  constructor(private readonly demoRequests: DemoRequestsService) {}

  @Post()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  create(@Body() dto: CreateDemoRequestDto) {
    return this.demoRequests.create(dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  list() {
    return this.demoRequests.list();
  }
}
