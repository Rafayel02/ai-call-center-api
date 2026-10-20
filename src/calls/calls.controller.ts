import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { IsObject, IsUUID } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CallRecordsService } from './call-records.service';
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
  constructor(
    private readonly calls: CallsService,
    private readonly records: CallRecordsService,
  ) {}

  @Post('browser')
  startBrowserCall(@Body() dto: StartBrowserCallDto, @CurrentUser() user: AuthUser) {
    return this.calls.startBrowserCall({ scenarioId: dto.scenarioId, graph: dto.graph, userId: user.id });
  }

  /** Phone calls across all scenarios, newest first. */
  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.records.list({ limit, cursor });
  }

  @Get('callbacks')
  callbacks() {
    return this.records.callbacks();
  }

  @Post(':id/called-back')
  calledBack(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.records.markCalledBack(id, user.id);
  }
}
