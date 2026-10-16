import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateSpeechModelDto, TestDraftDto, UpdateSpeechModelDto } from './dto/speech-model.dto';
import { SpeechToTextService } from './speech-to-text.service';

@Controller('speech-to-text-models')
@UseGuards(JwtAuthGuard)
export class SpeechToTextController {
  constructor(private readonly models: SpeechToTextService) {}

  @Get('providers')
  providers() {
    return this.models.providersAvailable();
  }

  @Post('test')
  testDraft(@Body() dto: TestDraftDto) {
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
  create(@Body() dto: CreateSpeechModelDto, @CurrentUser() user: AuthUser) {
    return this.models.create(dto, user.id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSpeechModelDto) {
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

  @Post(':id/transcribe')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 25 * 1024 * 1024 } }))
  transcribe(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: { buffer?: Buffer; size?: number; mimetype?: string; originalname?: string },
  ) {
    return this.models.transcribe(id, file);
  }
}
