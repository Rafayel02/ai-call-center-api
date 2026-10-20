import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CreatePhoneStreamingDto, TestPhoneStreamingDto, UpdatePhoneStreamingDto } from './dto/phone-streaming.dto';
import { PhoneStreamingService } from './phone-streaming.service';

@Controller('phone-streaming')
@UseGuards(JwtAuthGuard)
export class PhoneStreamingController {
  constructor(private readonly services: PhoneStreamingService) {}

  @Post('test')
  testDraft(@Body() dto: TestPhoneStreamingDto) {
    return this.services.testDraft(dto);
  }

  @Get()
  list() {
    return this.services.list();
  }

  @Post()
  create(@Body() dto: CreatePhoneStreamingDto, @CurrentUser() user: AuthUser) {
    return this.services.create(dto, user.id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePhoneStreamingDto) {
    return this.services.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.services.remove(id);
  }

  @Post(':id/test')
  test(@Param('id', ParseUUIDPipe) id: string) {
    return this.services.testStored(id);
  }
}
