import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateResourceDto } from './dto/create-resource.dto';
import { ImportSiteDto } from './dto/import-site.dto';
import { ResourcesService } from './resources.service';

@Controller('organizations/:organizationId/resources')
@UseGuards(JwtAuthGuard)
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  list(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    return this.resources.list(organizationId);
  }

  @Post('site')
  async importSite(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: ImportSiteDto,
    @CurrentUser() user: AuthUser,
    @Res() response: Response,
  ) {
    try {
      await this.resources.assertCanImport(organizationId, dto.url);
    } catch (error) {
      const status = error instanceof NotFoundException ? 404 : 400;
      const message = error instanceof BadRequestException || error instanceof NotFoundException ? error.message : 'The website could not be read.';
      response.status(status).json({ statusCode: status, message });
      return;
    }
    response.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('X-Accel-Buffering', 'no');
    try {
      await this.resources.importSite(organizationId, dto.url, user.id, (event) => {
        response.write(`${JSON.stringify(event)}\n`);
      });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'The website could not be read.';
      response.write(`${JSON.stringify({ type: 'failed', url: dto.url, message })}\n`);
    }
    response.end();
  }

  @Post()
  add(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: CreateResourceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.resources.add(organizationId, dto, user.id);
  }

  @Delete(':resourceId')
  remove(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
  ) {
    return this.resources.remove(organizationId, resourceId);
  }
}
