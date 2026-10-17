import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateScenarioDto } from './dto/create-scenario.dto';
import { SaveScenarioGraphDto } from './dto/save-scenario-graph.dto';
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

  @Patch(':id/active')
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetScenarioActiveDto) {
    return this.scenarios.setActive(id, dto.active);
  }

  @Patch(':id')
  saveGraph(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveScenarioGraphDto) {
    return this.scenarios.saveGraph(id, dto);
  }
}
