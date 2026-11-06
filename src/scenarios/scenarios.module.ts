import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { KnowledgeService } from './knowledge.service';
import { ScenariosController } from './scenarios.controller';
import { ScenariosService } from './scenarios.service';

@Module({
  imports: [LlmModule, OrganizationsModule],
  controllers: [ScenariosController],
  providers: [ScenariosService, KnowledgeService],
  exports: [KnowledgeService],
})
export class ScenariosModule {}