import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { DatasetModule } from './dataset/dataset.module';
import { HealthModule } from './health/health.module';
import { LlmModule } from './llm/llm.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { PrismaModule } from './prisma/prisma.module';
import { ScenarioExecutionsModule } from './scenario-executions/scenario-executions.module';
import { ScenariosModule } from './scenarios/scenarios.module';
import { SpeechToTextModule } from './speech-to-text/speech-to-text.module';
import { SpeechToTextComparisonModule } from './speech-to-text-comparison/speech-to-text-comparison.module';
import { TextToSpeechModule } from './text-to-speech/text-to-speech.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuthModule,
    UsersModule,
    SpeechToTextModule,
    SpeechToTextComparisonModule,
    TextToSpeechModule,
    LlmModule,
    DatasetModule,
    OrganizationsModule,
    ScenariosModule,
    ScenarioExecutionsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
