import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreatePhoneNumberDto, UpdatePhoneNumberDto } from './dto/phone-number.dto';
import { PhoneNumbersService } from './phone-numbers.service';

@Controller('phone-numbers')
@UseGuards(JwtAuthGuard)
export class PhoneNumbersController {
  constructor(private readonly numbers: PhoneNumbersService) {}

  @Get()
  list() {
    return this.numbers.list();
  }

  @Post()
  create(@Body() dto: CreatePhoneNumberDto) {
    return this.numbers.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePhoneNumberDto) {
    return this.numbers.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.numbers.remove(id);
  }
}
