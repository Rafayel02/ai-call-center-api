import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, StreamableFile, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateScenarioExecutionDto, FinishScenarioExecutionDto, PostExecutionEventsDto } from './dto/scenario-execution.dto';
import { ScenarioExecutionsService } from './scenario-executions.service';

interface UploadFile {
  buffer?: Buffer;
  size?: number;
  mimetype?: string;
}

@SkipThrottle()
@Controller()
@UseGuards(JwtAuthGuard)
export class ScenarioExecutionsController {
  constructor(private readonly executions: ScenarioExecutionsService) {}

  @Post('scenario-executions')
  create(@Body() dto: CreateScenarioExecutionDto, @CurrentUser() user: AuthUser) {
    return this.executions.create(dto, user.id);
  }

  @Get('scenarios/:scenarioId/caller-clips')
  callerClips(@Param('scenarioId', ParseUUIDPipe) scenarioId: string) {
    return this.executions.callerClips(scenarioId);
  }

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

  @Post('scenario-executions/:id/events')
  events(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PostExecutionEventsDto) {
    return this.executions.addEvents(id, dto.events);
  }

  @Post('scenario-executions/:id/heartbeat')
  heartbeat(@Param('id', ParseUUIDPipe) id: string) {
    return this.executions.heartbeat(id);
  }

  @Post('scenario-executions/:id/finish')
  finish(@Param('id', ParseUUIDPipe) id: string, @Body() dto: FinishScenarioExecutionDto) {
    return this.executions.finish(id, dto);
  }

  @Post('scenario-executions/:id/audio')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'caller', maxCount: 1 },
        { name: 'mix', maxCount: 1 },
      ],
      { limits: { fileSize: 32 * 1024 * 1024 } },
    ),
  )
  saveAudio(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: { caller?: UploadFile[]; mix?: UploadFile[] },
    @Body('peaks') peaks?: string,
  ) {
    return this.executions.saveAudio(id, files ?? {}, peaks);
  }
}
