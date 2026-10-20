import { BadRequestException, BeforeApplicationShutdown, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallEndReason, ExecutionChannel } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import { ScenarioExecutionsService } from '../scenario-executions/scenario-executions.service';
import { parseScenarioGraph, readScenarioGraph, ScenarioGraph } from '../scenarios/scenario-graph';
import { ScenariosService } from '../scenarios/scenarios.service';
import { SpeechToTextService } from '../speech-to-text/speech-to-text.service';
import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { hangUpTwiml, streamTwiml } from '../telephony/twiml';
import { CallRecordsService } from './call-records.service';
import { CallServices, CallSession } from './call-session';
import { STREAM_START_LIMIT_MS } from './call-timing';
import { mintCallToken, readCallToken } from './call-token';
import { CallTransport } from './call-transport';
import { BROWSER_STREAM_PATH, publicStreamUrl, TWILIO_STREAM_PATH } from './public-url';

interface PendingCall {
  executionId: string;
  graph: ScenarioGraph;
  channel: ExecutionChannel;
  createdAt: number;
  /** The call row of a phone call. */
  callId: string | null;
  timer: ReturnType<typeof setTimeout>;
}

const NOT_CONNECTED = 'The media stream did not connect.';

/** Starts calls and holds the live ones. A session lives in this process, next to its WebSocket. */
@Injectable()
export class CallsService implements BeforeApplicationShutdown {
  /** How long a started call waits for its stream. Tests shorten it. */
  streamStartLimitMs = STREAM_START_LIMIT_MS;
  private readonly logger = new Logger(CallsService.name);
  private readonly pending = new Map<string, PendingCall>();
  private readonly live = new Set<CallSession>();
  private draining = false;

  constructor(
    private readonly config: ConfigService,
    private readonly scenarios: ScenariosService,
    private readonly executions: ScenarioExecutionsService,
    private readonly records: CallRecordsService,
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
    this.hold({ executionId, graph, channel: ExecutionChannel.BROWSER, createdAt, callId: null });
    return {
      executionId,
      token: mintCallToken(secret, executionId),
      streamUrl: publicStreamUrl(this.config, BROWSER_STREAM_PATH),
    };
  }

  /**
   * Twilio's voice webhook, after its signature was checked. Returns TwiML: a media stream to the number's published
   * scenario, or a hang-up when the number runs no published scenario.
   */
  async answerPhoneCall(input: { callSid: string; from: string | null; to: string }) {
    const number = await this.records.findNumber(input.to);
    if (!number || !number.scenario.active || this.draining) {
      await this.records.recordUnanswered({
        callSid: input.callSid,
        from: input.from,
        to: input.to,
        phoneNumberId: number?.id ?? null,
        ...(this.draining && number?.scenario.active ? { endReason: CallEndReason.ERROR, error: 'The server was restarting.' } : {}),
      });
      return hangUpTwiml();
    }
    const secret = this.secret();
    const existing = await this.records.findByProviderId(input.callSid);
    if (existing) {
      // Twilio sent the webhook again. The call can still connect while its stream has not started.
      const pending = existing.executionId ? this.pending.get(existing.executionId) : undefined;
      return pending ? this.streamResponse(existing.id, pending.executionId, secret) : hangUpTwiml();
    }
    const graph = readScenarioGraph(number.scenario.graph);
    const createdAt = Date.now();
    const executionId = await this.executions.startSession({
      scenarioId: number.scenario.id,
      graph,
      channel: ExecutionChannel.PHONE,
      startedById: null,
    });
    const callId = await this.records.open({ executionId, phoneNumberId: number.id, callSid: input.callSid, from: input.from, to: input.to });
    this.hold({ executionId, graph, channel: ExecutionChannel.PHONE, createdAt, callId });
    return this.streamResponse(callId, executionId, secret);
  }

  /**
   * Called with the stream's `start` message. A valid token is used up here, so it works once, and only on the
   * stream of its own channel. Returns null otherwise, and the stream must close before any audio.
   */
  attach(
    token: string | undefined,
    transport: CallTransport,
    start: { callSid?: string; streamSid?: string },
    channel: ExecutionChannel,
  ): CallSession | null {
    if (!token || this.draining) return null;
    const callId = readCallToken(this.secret(), token);
    const call = callId ? this.pending.get(callId) : undefined;
    if (!call || call.channel !== channel) return null;
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
    void session.done
      .then((outcome) => (call.callId ? this.records.finish(call.callId, outcome) : undefined))
      .catch((error: unknown) => this.logger.warn(`Could not close call ${call.callId}: ${error instanceof Error ? error.message : 'unknown error'}`))
      .finally(() => this.live.delete(session));
    return session;
  }

  /** Lets live calls finish before the process stops. Railway's draining time decides how long that can take. */
  async beforeApplicationShutdown() {
    this.draining = true;
    if (this.live.size > 0) this.logger.log(`Waiting for ${this.live.size} live calls to end.`);
    await Promise.allSettled([...this.live].map((session) => session.done));
  }

  private streamResponse(callId: string, executionId: string, secret: string) {
    return streamTwiml(publicStreamUrl(this.config, TWILIO_STREAM_PATH), { callId, token: mintCallToken(secret, executionId) });
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
          errorMessage: NOT_CONNECTED,
        })
        .then(() => (call.callId ? this.records.finish(call.callId, { status: 'FAILED', errorMessage: NOT_CONNECTED, callbackReason: null }) : undefined))
        .catch(() => undefined);
    }, this.streamStartLimitMs);
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
    if (!secret || secret.length < 16) throw new BadRequestException('Set CALL_TOKEN_SECRET on the API before starting a call.');
    return secret;
  }
}
