import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { IsObject, IsUUID } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CallsService } from './calls.service';

export class StartBrowserCallDto {
  @IsUUID()
  scenarioId!: string;

  @IsObject()
  graph!: Record<string, unknown>;
}

@Controller('calls')
@UseGuards(JwtAuthGuard)
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Post('browser')
  startBrowserCall(@Body() dto: StartBrowserCallDto, @CurrentUser() user: AuthUser) {
    return this.calls.startBrowserCall({ scenarioId: dto.scenarioId, graph: dto.graph, userId: user.id });
  }
}
