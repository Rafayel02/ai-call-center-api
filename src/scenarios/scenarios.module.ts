import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { ScenariosController } from './scenarios.controller';
import { ScenariosService } from './scenarios.service';

@Module({
  imports: [LlmModule],
  controllers: [ScenariosController],
  providers: [ScenariosService],
})
export class ScenariosModule {}