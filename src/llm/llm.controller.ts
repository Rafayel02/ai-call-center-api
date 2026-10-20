import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CompleteTurnDto, CreateLlmModelDto, RouteCallDto, TestLlmDraftDto, UpdateLlmModelDto } from './dto/llm-model.dto';
import { LlmService } from './llm.service';

@Controller('llm-models')
@UseGuards(JwtAuthGuard)
export class LlmController {
  constructor(private readonly models: LlmService) {}

  @Get('providers')
  providers() {
    return this.models.providersAvailable();
  }

  @Post('test')
  testDraft(@Body() dto: TestLlmDraftDto) {
    return this.models.testDraft(dto);
  }

  @Get()
  list() {
    return this.models.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.models.get(id);
  }

  @Post()
  create(@Body() dto: CreateLlmModelDto, @CurrentUser() user: AuthUser) {
    return this.models.create(dto, user.id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLlmModelDto) {
    return this.models.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.models.remove(id);
  }

  @Post(':id/test')
  test(@Param('id', ParseUUIDPipe) id: string) {
    return this.models.testStored(id);
  }

  @Post(':id/complete')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  complete(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteTurnDto) {
    return this.models.complete(id, dto);
  }

  @Post(':id/route')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  route(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RouteCallDto) {
    return this.models.route(id, dto);
  }
}
