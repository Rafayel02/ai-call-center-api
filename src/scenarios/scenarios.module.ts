import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { KnowledgeService } from './knowledge.service';
import { ScenariosController } from './scenarios.controller';
import { ScenariosService } from './scenarios.service';

@Module({
  imports: [LlmModule],
  controllers: [ScenariosController],
  providers: [ScenariosService, KnowledgeService],
  exports: [KnowledgeService],
})
export class ScenariosModule {}