import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CallbackReason, CallEndReason, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decodeCursor, encodeCursor, ScenarioExecutionsService, SessionEnding } from '../scenario-executions/scenario-executions.service';

const callSelect = {
  id: true,
  fromNumber: true,
  toNumber: true,
  startedAt: true,
  endedAt: true,
  endReason: true,
  error: true,
  callbackReason: true,
  calledBackAt: true,
  calledBackBy: { select: { email: true } },
  execution: {
    select: {
      id: true,
      durationMs: true,
      inquiry: true,
      menuChoice: true,
      topicLabel: true,
      scenario: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.CallSelect;

type CallRow = Prisma.CallGetPayload<{ select: typeof callSelect }>;

const END_REASON: Record<SessionEnding['status'], CallEndReason> = {
  FINISHED: CallEndReason.COMPLETED,
  STOPPED: CallEndReason.CALLER_HUNG_UP,
  FAILED: CallEndReason.ERROR,
};

/** The `calls` table: what the phone line knows about each call. The run itself is the execution. */
@Injectable()
export class CallRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executions: ScenarioExecutionsService,
  ) {}

  findNumber(e164: string) {
    return this.prisma.phoneNumber.findUnique({
      where: { e164 },
      select: { id: true, scenario: { select: { id: true, active: true, graph: true } } },
    });
  }

  findByProviderId(providerCallId: string) {
    return this.prisma.call.findUnique({ where: { providerCallId }, select: { id: true, executionId: true, endReason: true } });
  }

  /**
   * A call that was hung up at once: no published scenario for the number, unless another reason is given. It ends
   * as soon as it is stored. A repeated webhook stores nothing new.
   */
  async recordUnanswered(input: {
    callSid: string;
    from: string | null;
    to: string;
    phoneNumberId: string | null;
    endReason?: CallEndReason;
    error?: string;
  }) {
    try {
      await this.prisma.call.create({
        data: {
          providerCallId: input.callSid,
          fromNumber: input.from,
          toNumber: input.to,
          phoneNumberId: input.phoneNumberId,
          endReason: input.endReason ?? CallEndReason.NO_SCENARIO,
          error: input.error ?? null,
          endedAt: new Date(),
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    }
  }

  async open(input: { executionId: string; phoneNumberId: string; callSid: string; from: string | null; to: string }) {
    const row = await this.prisma.call.create({
      data: {
        executionId: input.executionId,
        phoneNumberId: input.phoneNumberId,
        providerCallId: input.callSid,
        fromNumber: input.from,
        toNumber: input.to,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Closes a call row from how its session ended. A call keeps its first callback reason and its first ending. */
  async finish(callId: string, ending: { status: SessionEnding['status']; errorMessage: string | null; callbackReason: CallbackReason | null }) {
    if (ending.callbackReason) {
      await this.prisma.call.updateMany({ where: { id: callId, callbackReason: null }, data: { callbackReason: ending.callbackReason } });
    }
    await this.prisma.call.updateMany({
      where: { id: callId, endReason: null },
      data: { endReason: END_REASON[ending.status], error: ending.errorMessage, endedAt: new Date() },
    });
  }

  async list(query: { limit?: string; cursor?: string }) {
    await this.executions.settleStale();
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) throw new BadRequestException('The cursor is not valid.');
    const rows = await this.prisma.call.findMany({
      where: cursor ? { OR: [{ startedAt: { lt: cursor.startedAt } }, { startedAt: cursor.startedAt, id: { lt: cursor.id } }] } : {},
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: callSelect,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.present(row)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.startedAt, last.id) : null,
    };
  }

  /** Marked calls that no one has called back yet, newest first. */
  async callbacks() {
    await this.executions.settleStale();
    const rows = await this.prisma.call.findMany({
      where: { callbackReason: { not: null }, calledBackAt: null },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: callSelect,
    });
    return rows.map((row) => this.present(row));
  }

  async markCalledBack(id: string, userId: string) {
    const row = await this.prisma.call.findUnique({ where: { id }, select: { callbackReason: true, calledBackAt: true } });
    if (!row) throw new NotFoundException('Call not found.');
    if (!row.callbackReason) throw new BadRequestException('This call is not waiting for a callback.');
    if (!row.calledBackAt) {
      await this.prisma.call.update({ where: { id }, data: { calledBackAt: new Date(), calledBackById: userId } });
    }
    return this.present(await this.prisma.call.findUniqueOrThrow({ where: { id }, select: callSelect }));
  }

  private present(row: CallRow) {
    const execution = row.execution;
    return {
      id: row.id,
      fromNumber: row.fromNumber,
      toNumber: row.toNumber,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMs: execution?.durationMs ?? (row.endedAt ? row.endedAt.getTime() - row.startedAt.getTime() : null),
      endReason: row.endReason,
      error: row.error,
      callbackReason: row.callbackReason,
      calledBackAt: row.calledBackAt,
      calledBackBy: row.calledBackBy ? { email: row.calledBackBy.email } : null,
      executionId: execution?.id ?? null,
      scenario: execution?.scenario ?? null,
      inquiry: execution?.inquiry ?? null,
      menuChoice: execution?.menuChoice ?? null,
      topicLabel: execution?.topicLabel ?? null,
    };
  }
}
