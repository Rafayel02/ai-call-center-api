import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DemoProfilesService } from './demo-profiles.service';
import { SaveDemoProfileDto, StartDemoSessionDto } from './dto/save-demo-profile.dto';

@Controller('demo-profiles')
export class DemoProfilesController {
  constructor(private readonly profiles: DemoProfilesService) {}

  @Get('public/:key')
  publicProfile(@Param('key') key: string) {
    return this.profiles.publicProfile(key);
  }

  @Post('public/:key/sessions')
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  start(@Param('key') key: string, @Body() dto: StartDemoSessionDto) {
    return this.profiles.startSession(key, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  list() {
    return this.profiles.list();
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() dto: SaveDemoProfileDto) {
    return this.profiles.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SaveDemoProfileDto) {
    return this.profiles.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.profiles.remove(id);
  }
}
