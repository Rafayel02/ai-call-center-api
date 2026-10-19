import { BadRequestException, BeforeApplicationShutdown, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionChannel } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import { ScenarioExecutionsService } from '../scenario-executions/scenario-executions.service';
import { parseScenarioGraph, ScenarioGraph } from '../scenarios/scenario-graph';
import { ScenariosService } from '../scenarios/scenarios.service';
import { SpeechToTextService } from '../speech-to-text/speech-to-text.service';
import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { CallServices, CallSession } from './call-session';
import { STREAM_START_LIMIT_MS } from './call-timing';
import { CALL_TOKEN_TTL_MS, mintCallToken, readCallToken } from './call-token';
import { CallTransport } from './call-transport';

interface PendingCall {
  executionId: string;
  graph: ScenarioGraph;
  channel: ExecutionChannel;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Starts calls and holds the live ones. A session lives in this process, next to its WebSocket. */
@Injectable()
export class CallsService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(CallsService.name);
  private readonly pending = new Map<string, PendingCall>();
  private readonly live = new Set<CallSession>();
  private draining = false;

  constructor(
    private readonly config: ConfigService,
    private readonly scenarios: ScenariosService,
    private readonly executions: ScenarioExecutionsService,
    private readonly speechToText: SpeechToTextService,
    private readonly textToSpeech: TextToSpeechService,
    private readonly llm: LlmService,
  ) {}

  /** Play in the designer: checks the graph on the canvas, creates the execution, and returns a token for the stream. */
  async startBrowserCall(input: { scenarioId: string; graph: unknown; userId: string }) {
    if (this.draining) throw new ServiceUnavailableException('The server is restarting. Try again in a moment.');
    const secret = this.secret();
    const graph = parseScenarioGraph(input.graph);
    await this.scenarios.assertRunnable(graph);
    const createdAt = Date.now();
    const executionId = await this.executions.startSession({
      scenarioId: input.scenarioId,
      graph,
      channel: ExecutionChannel.BROWSER,
      startedById: input.userId,
    });
    this.hold({ executionId, graph, channel: ExecutionChannel.BROWSER, createdAt });
    return {
      executionId,
      token: mintCallToken(secret, executionId),
      streamUrl: `${this.publicBaseUrl().replace(/^http/, 'ws')}/calls/browser/stream`,
    };
  }

  /**
   * Called with the stream's `start` message. A valid token is used up here, so it works once. Returns null when
   * the token is missing, expired, reused, or for another call, and the stream must close before any audio.
   */
  attach(token: string | undefined, transport: CallTransport, start: { callSid?: string; streamSid?: string }): CallSession | null {
    if (!token || this.draining) return null;
    const callId = readCallToken(this.secret(), token);
    const call = callId ? this.pending.get(callId) : undefined;
    if (!call) return null;
    this.pending.delete(call.executionId);
    clearTimeout(call.timer);
    const session = new CallSession({
      executionId: call.executionId,
      graph: call.graph,
      channel: call.channel,
      transport,
      services: this.servicesFor(call.executionId),
      createdAt: call.createdAt,
      start,
    });
    this.live.add(session);
    void session.done.finally(() => this.live.delete(session));
    return session;
  }

  /** Lets live calls finish before the process stops. Railway's draining time decides how long that can take. */
  async beforeApplicationShutdown() {
    this.draining = true;
    if (this.live.size > 0) this.logger.log(`Waiting for ${this.live.size} live calls to end.`);
    await Promise.allSettled([...this.live].map((session) => session.done));
  }

  private hold(call: Omit<PendingCall, 'timer'>) {
    const timer = setTimeout(() => {
      if (!this.pending.delete(call.executionId)) return;
      void this.executions
        .closeSession(call.executionId, {
          status: 'FAILED',
          durationMs: Date.now() - call.createdAt,
          inquiry: null,
          topicId: null,
          topicLabel: null,
          menuChoice: null,
          errorMessage: 'The media stream did not connect.',
        })
        .catch(() => undefined);
    }, Math.max(STREAM_START_LIMIT_MS, CALL_TOKEN_TTL_MS));
    this.pending.set(call.executionId, { ...call, timer });
  }

  private servicesFor(executionId: string): CallServices {
    return {
      transcribe: async (modelId, wav, context, signal) => {
        const result = await this.speechToText.transcribe(
          modelId,
          { buffer: wav, size: wav.length, mimetype: 'audio/wav', originalname: 'utterance.wav' },
          context,
          signal,
        );
        return result.text;
      },
      clip: async (modelId, text, context, signal) => (await this.textToSpeech.clip(modelId, text, 'ulaw_8000', context, signal)).audio,
      complete: (modelId, request, context, signal) => this.llm.complete(modelId, request, context, signal),
      describeLlm: async (modelId) => {
        const model = await this.llm.get(modelId);
        return { modelId: model.id, modelName: model.name, provider: model.provider, providerModel: model.config.modelId };
      },
      writeEvents: (events) => this.executions.writeSessionEvents(executionId, events),
      heartbeat: async () => {
        await this.executions.heartbeatSession(executionId);
      },
      storeRecordings: (recordings) => this.executions.storeRecordings(executionId, recordings),
      close: (ending) => this.executions.closeSession(executionId, ending),
    };
  }

  private secret() {
    const secret = this.config.get<string>('CALL_TOKEN_SECRET')?.trim();
    if (!secret || secret.length < 16) throw new BadRequestException('Set CALL_TOKEN_SECRET on the API before playing a scenario.');
    return secret;
  }

  private publicBaseUrl() {
    const configured = this.config.get<string>('PUBLIC_BASE_URL')?.trim().replace(/\/+$/, '');
    return configured || `http://localhost:${this.config.get<string>('PORT') ?? '3001'}`;
  }
}
