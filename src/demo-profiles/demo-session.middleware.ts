import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { createHash } from 'crypto';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { demoBearer, demoRoute } from './demo-access';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

@Injectable()
export class DemoSessionMiddleware implements NestMiddleware {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  async use(request: Request, response: Response, next: NextFunction) {
    const token = demoBearer(request.header('authorization'));
    if (!token) {
      next();
      return;
    }

    const route = demoRoute(request.method, request.originalUrl || request.url);
    if (!route) {
      response.status(403).json({ statusCode: 403, message: 'This demo session cannot do that.' });
      return;
    }

    const session = await this.prisma.demoSession.findUnique({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
      include: {
        profile: { select: { enabled: true } },
        scenario: { select: { createdBy: { select: { id: true, email: true, role: true } } } },
      },
    });
    if (!session || !session.profile.enabled || session.expiresAt.getTime() <= Date.now()) {
      response.status(401).json({ statusCode: 401, message: 'This demo session has ended. Start again.' });
      return;
    }

    if (route.kind === 'model' && !session.allowedModelIds.includes(route.modelId)) {
      response.status(403).json({ statusCode: 403, message: 'This demo cannot use that model.' });
      return;
    }

    if (route.kind === 'create-execution') {
      const body = request.body as { id?: unknown; scenarioId?: unknown } | undefined;
      const id = typeof body?.id === 'string' ? body.id : '';
      const scenarioId = typeof body?.scenarioId === 'string' ? body.scenarioId : '';
      if (!UUID.test(id) || scenarioId !== session.scenarioId) {
        response.status(403).json({ statusCode: 403, message: 'This demo cannot start that scenario.' });
        return;
      }
      if (session.executionId && session.executionId !== id) {
        response.status(403).json({ statusCode: 403, message: 'This demo cannot start that scenario.' });
        return;
      }
      if (!session.executionId) {
        await this.prisma.demoSession.updateMany({ where: { id: session.id, executionId: null }, data: { executionId: id } });
        const saved = await this.prisma.demoSession.findUnique({ where: { id: session.id }, select: { executionId: true } });
        if (saved?.executionId !== id) {
          response.status(403).json({ statusCode: 403, message: 'This demo cannot start that scenario.' });
          return;
        }
      }
    }

    if (route.kind === 'execution' && session.executionId !== route.executionId) {
      response.status(403).json({ statusCode: 403, message: 'This demo cannot update that run.' });
      return;
    }

    const accessToken = await this.auth.signAccess(session.scenario.createdBy, '5m');
    request.cookies = { ...request.cookies, access_token: accessToken };
    delete request.headers.authorization;
    next();
  }
}
