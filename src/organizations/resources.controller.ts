import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateResourceDto } from './dto/create-resource.dto';
import { ResourcesService } from './resources.service';

@Controller('organizations/:organizationId/resources')
@UseGuards(JwtAuthGuard)
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  list(@Param('organizationId', ParseUUIDPipe) organizationId: string) {
    return this.resources.list(organizationId);
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
