import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { DatasetService } from './dataset.service';
import { CreateDatasetSampleDto } from './dto/create-dataset-sample.dto';

@Controller('dataset-samples')
@UseGuards(JwtAuthGuard)
export class DatasetController {
  constructor(private readonly samples: DatasetService) {}

  @Get()
  list() {
    return this.samples.list();
  }

  @Post()
  @UseInterceptors(FileInterceptor('audio', { limits: { fileSize: 25 * 1024 * 1024 } }))
  create(
    @Body() dto: CreateDatasetSampleDto,
    @UploadedFile() file: { buffer?: Buffer; size?: number; mimetype?: string; originalname?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.samples.create(dto, file, user.id);
  }

  @Get(':id/audio')
  async audio(@Param('id', ParseUUIDPipe) id: string) {
    const sample = await this.samples.audio(id);
    const filename = sample.filename.replace(/["\r\n]/g, '');
    return new StreamableFile(Buffer.from(sample.audio), {
      type: sample.mimeType,
      disposition: `inline; filename="${filename}"`,
    });
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.samples.remove(id);
  }
}
