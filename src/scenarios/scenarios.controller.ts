import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AddScenarioLanguageDto } from './dto/add-scenario-language.dto';
import { AddContextSourceDto, LearnContextDto } from './dto/context-source.dto';
import { CreateScenarioDto } from './dto/create-scenario.dto';
import { SaveScenarioGraphDto } from './dto/save-scenario-graph.dto';
import { AttachPhoneNumberDto } from './dto/attach-phone-number.dto';
import { SetScenarioActiveDto } from './dto/set-scenario-active.dto';
import { ScenariosService } from './scenarios.service';

@Controller('scenarios')
@UseGuards(JwtAuthGuard)
export class ScenariosController {
  constructor(private readonly scenarios: ScenariosService) {}

  @Get()
  list() {
    return this.scenarios.list();
  }

  @Post()
  create(@Body() dto: CreateScenarioDto, @CurrentUser() user: AuthUser) {
    return this.scenarios.create(dto, user.id);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.scenarios.get(id);
  }

  @Post(':id/languages')
  addLanguage(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddScenarioLanguageDto) {
    return this.scenarios.addLanguage(id, dto.language);
  }

  @Patch(':id/phone-number')
  attachPhoneNumber(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachPhoneNumberDto) {
    return this.scenarios.attachPhoneNumber(id, dto.phoneNumberId ?? null);
  }

  @Patch(':id/active')
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetScenarioActiveDto) {
    return this.scenarios.setActive(id, dto.active);
  }

  @Patch(':id')
  saveGraph(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveScenarioGraphDto) {
    return this.scenarios.saveGraph(id, dto);
  }

  @Post(':id/context/sources')
  addContextSource(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddContextSourceDto) {
    return this.scenarios.addContextSource(id, dto);
  }

  @Delete(':id/context/sources/:sourceId')
  removeContextSource(@Param('id', ParseUUIDPipe) id: string, @Param('sourceId', ParseUUIDPipe) sourceId: string) {
    return this.scenarios.removeContextSource(id, sourceId);
  }

  @Post(':id/context/learn')
  learnContext(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LearnContextDto) {
    return this.scenarios.learnContext(id, dto.prompts);
  }

  @Post(':id/context/translate')
  translateContext(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LearnContextDto) {
    return this.scenarios.translateContext(id, dto.prompts);
  }
}
