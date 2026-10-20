import { ExecutionStatus } from '@prisma/client';
import { ExecutionContext, SpokenKind } from '../scenario-executions/execution-context';
import { ScenarioExecutionsService } from '../scenario-executions/scenario-executions.service';
import { CallRecording } from './call-recording';

export interface CallLog {
  inquiry: string | null;
  topicId: string | null;
  topicLabel: string | null;
  now(): number;
  context(
    nodeId: string | null,
    kind: SpokenKind | null,
    utterance?: { startedMs: number; durationMs: number },
  ): ExecutionContext | null;
  played(input: { nodeId: string | null; text: string; kind: SpokenKind; startMs: number; endMs: number }): Promise<void>;
  caller(samples: Int16Array): void;
  agent(samples: Int16Array): void;
  touch(): Promise<void>;
  finish(status: 'FINISHED' | 'STOPPED' | 'FAILED', errorMessage?: string): Promise<void>;
}

export const silentLog: CallLog = {
  inquiry: null,
  topicId: null,
  topicLabel: null,
  now: () => 0,
  context: () => null,
  played: async () => undefined,
  caller: () => undefined,
  agent: () => undefined,
  touch: async () => undefined,
  finish: async () => undefined,
};

/** Writes one phone call into the same execution record Play uses, tagged as a phone call. */
export class PhoneCallLog implements CallLog {
  private seq = 0;
  private readonly recording = new CallRecording();
  inquiry: string | null = null;
  topicId: string | null = null;
  topicLabel: string | null = null;

  constructor(
    private readonly executionId: string,
    private readonly executions: ScenarioExecutionsService,
  ) {}

  now() {
    return this.recording.elapsedMs();
  }

  context(nodeId: string | null, kind: SpokenKind | null, utterance?: { startedMs: number; durationMs: number }): ExecutionContext {
    const seq = this.seq;
    this.seq += 1;
    return {
      executionId: this.executionId,
      clientSeq: seq,
      offsetMs: this.now(),
      nodeId,
      utteranceStartedMs: utterance?.startedMs ?? null,
      utteranceDurationMs: utterance?.durationMs ?? null,
      ttsKind: kind,
    };
  }

  async played(input: { nodeId: string | null; text: string; kind: SpokenKind; startMs: number; endMs: number }) {
    const seq = this.seq;
    this.seq += 1;
    await this.executions.addEvents(this.executionId, [
      {
        clientSeq: seq,
        offsetMs: input.startMs,
        type: 'tts.played',
        nodeId: input.nodeId,
        payload: { text: input.text, kind: input.kind, endMs: input.endMs, interrupted: false },
      },
    ]);
  }

  caller(samples: Int16Array) {
    this.recording.addCaller(samples);
  }

  agent(samples: Int16Array) {
    this.recording.addAgent(samples);
  }

  touch() {
    return this.executions.heartbeat(this.executionId).then(() => undefined, () => undefined);
  }

  async finish(status: 'FINISHED' | 'STOPPED' | 'FAILED', errorMessage?: string) {
    const mix = this.recording.mix();
    await this.executions.completePhone(this.executionId, {
      status: ExecutionStatus[status],
      durationMs: Math.round(Math.max(this.now(), mix.durationMs)),
      inquiry: this.inquiry,
      topicId: this.topicId,
      topicLabel: this.topicLabel,
      errorMessage: errorMessage ?? null,
      wav: mix.wav,
      peaks: mix.peaks,
    });
  }
}
