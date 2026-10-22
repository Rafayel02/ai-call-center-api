import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DemoProfilesController } from './demo-profiles.controller';
import { DemoProfilesService } from './demo-profiles.service';
import { DemoSessionMiddleware } from './demo-session.middleware';

@Module({
  imports: [AuthModule],
  controllers: [DemoProfilesController],
  providers: [DemoProfilesService, DemoSessionMiddleware],
})
export class DemoProfilesModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(DemoSessionMiddleware).forRoutes(
      { path: 'text-to-speech-models/:id/speak', method: RequestMethod.POST },
      { path: 'speech-to-text-models/:id/transcribe', method: RequestMethod.POST },
      { path: 'llm-models/:id/complete', method: RequestMethod.POST },
      { path: 'llm-models/:id/closing', method: RequestMethod.POST },
      { path: 'scenario-executions', method: RequestMethod.POST },
      { path: 'scenario-executions/:id/events', method: RequestMethod.POST },
      { path: 'scenario-executions/:id/heartbeat', method: RequestMethod.POST },
      { path: 'scenario-executions/:id/finish', method: RequestMethod.POST },
      { path: 'scenario-executions/:id/audio', method: RequestMethod.POST },
    );
  }
}
