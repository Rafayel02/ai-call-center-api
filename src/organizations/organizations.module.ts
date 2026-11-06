import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';

@Module({
  imports: [LlmModule],
  controllers: [OrganizationsController, ResourcesController],
  providers: [OrganizationsService, ResourcesService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
