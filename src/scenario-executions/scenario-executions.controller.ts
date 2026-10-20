import { Controller, Get, Param, ParseUUIDPipe, Query, StreamableFile, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ScenarioExecutionsService } from './scenario-executions.service';

/** Reads executions. The call session writes them in process, so there is no write endpoint. */
@SkipThrottle()
@Controller()
@UseGuards(JwtAuthGuard)
export class ScenarioExecutionsController {
  constructor(private readonly executions: ScenarioExecutionsService) {}

  @Get('scenarios/:scenarioId/executions')
  list(
    @Param('scenarioId', ParseUUIDPipe) scenarioId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.executions.list(scenarioId, { status, limit, cursor });
  }

  @Get('scenario-executions/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.executions.get(id);
  }

  @Get('scenario-executions/:id/mix')
  async mix(@Param('id', ParseUUIDPipe) id: string) {
    const file = await this.executions.mix(id);
    return new StreamableFile(Buffer.from(file.audio), {
      type: file.mimeType,
      disposition: 'inline; filename="mix"',
    });
  }

  @Get('scenario-executions/:id/audio/:audioId')
  async audio(@Param('id', ParseUUIDPipe) id: string, @Param('audioId', ParseUUIDPipe) audioId: string) {
    const file = await this.executions.audioFile(id, audioId);
    return new StreamableFile(Buffer.from(file.audio), {
      type: file.mimeType,
      disposition: 'inline; filename="audio"',
    });
  }
}
