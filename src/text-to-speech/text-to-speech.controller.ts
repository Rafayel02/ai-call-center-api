import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateTextToSpeechModelDto, SpeakDto, TestTextToSpeechDraftDto, UpdateTextToSpeechModelDto } from './dto/text-to-speech-model.dto';
import { TextToSpeechService } from './text-to-speech.service';

@Controller('text-to-speech-models')
@UseGuards(JwtAuthGuard)
export class TextToSpeechController {
  constructor(private readonly models: TextToSpeechService) {}

  @Get('providers')
  providers() {
    return this.models.providersAvailable();
  }

  @Post('test')
  testDraft(@Body() dto: TestTextToSpeechDraftDto) {
    return this.models.testDraft(dto);
  }

  @Post('voices')
  voices(@Body() dto: TestTextToSpeechDraftDto) {
    return this.models.voicesForDraft(dto);
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
  create(@Body() dto: CreateTextToSpeechModelDto, @CurrentUser() user: AuthUser) {
    return this.models.create(dto, user.id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTextToSpeechModelDto) {
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

  @Post(':id/voices')
  storedVoices(@Param('id', ParseUUIDPipe) id: string) {
    return this.models.voicesForStored(id);
  }

  @Post(':id/speak')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  speak(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SpeakDto) {
    return this.models.speak(id, dto.text);
  }
}
