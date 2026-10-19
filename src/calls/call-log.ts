import { Logger } from '@nestjs/common';
import { ExecutionContext, SpokenKind } from '../scenario-executions/execution-context';
import { SessionEvent } from '../scenario-executions/scenario-executions.service';

const WRITE_ATTEMPTS = 3;

/**
 * The session's side of the execution record. It numbers every event, including the provider events the services
 * write from an ExecutionContext, and writes its own events in order through one queue. A slow or failed write never
 * holds up the call.
 */
export class CallLog {
  private seq = 0;
  private readonly known = new Map<number, SessionEvent>();
  private readonly pending = new Map<number, SessionEvent>();
  private chain: Promise<void> = Promise.resolve();
  private readonly logger = new Logger(CallLog.name);

  constructor(
    readonly executionId: string,
    private readonly write: (events: SessionEvent[]) => Promise<void>,
    private readonly clock: () => number,
  ) {}

  /** Records an event and returns its number. `offsetMs` defaults to now. */
  event(type: string, payload: Record<string, unknown>, nodeId: string | null, offsetMs = this.clock()) {
    const seq = this.next();
    this.put({ seq, offsetMs: Math.max(0, Math.round(offsetMs)), type, nodeId, payload });
    return seq;
  }

  /** Changes the payload of an event already recorded. It is written again under the same number. */
  amend(seq: number, patch: Record<string, unknown>) {
    const event = this.known.get(seq);
    if (event) this.put({ ...event, payload: { ...event.payload, ...patch } });
  }

  /** A context for a provider call, so the service records its event under the next number. */
  context(input: { nodeId: string | null; kind?: SpokenKind; utterance?: { startedMs: number; durationMs: number } }): ExecutionContext {
    return {
      executionId: this.executionId,
      clientSeq: this.next(),
      offsetMs: Math.max(0, Math.round(this.clock())),
      nodeId: input.nodeId,
      utteranceStartedMs: input.utterance ? Math.round(input.utterance.startedMs) : null,
      utteranceDurationMs: input.utterance ? Math.round(input.utterance.durationMs) : null,
      ttsKind: input.kind ?? null,
    };
  }

  /** Resolves when every event recorded so far has been written or given up on. */
  flush() {
    this.chain = this.chain.then(() => this.drain());
    return this.chain;
  }

  private next() {
    this.seq += 1;
    return this.seq;
  }

  private put(event: SessionEvent) {
    this.known.set(event.seq, event);
    this.pending.set(event.seq, event);
    this.chain = this.chain.then(() => this.drain());
  }

  private async drain() {
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
      try {
        await this.write(batch);
        return;
      } catch (error) {
        if (attempt === WRITE_ATTEMPTS) {
          this.logger.warn(`Could not record ${batch.length} events for execution ${this.executionId}: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
    }
  }
}
