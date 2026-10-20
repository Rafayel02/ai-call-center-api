import { ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { ExecutionStatus } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import { ScenarioExecutionsService } from '../scenario-executions/scenario-executions.service';
import { PhoneStreamingService } from '../phone-streaming/phone-streaming.service';
import { PrismaService } from '../prisma/prisma.service';
import { readScenarioGraph, ScenarioGraph } from '../scenarios/scenario-graph';
import { SpeechToTextService } from '../speech-to-text/speech-to-text.service';
import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { PhoneCallLog, silentLog } from './call-log';
import { mintCallToken, readCallToken } from './call-token';
import { CallDeps, PhoneScenarioSession } from './call-session';
import { isTwilioSignature } from './twilio-signature';
import { ScenarioLanguage, ScenarioLanguageModels, isScenarioLanguage, languageKeyLine, languageModelsFor } from '../scenarios/scenario-languages';
import { decodeUlaw, pcmWav } from './ulaw';
import { hangupTwiml, sayTwiml, streamTwiml } from './twiml';

const MISSING = 'Add a Twilio phone streaming service before taking phone calls.';
const NOT_READY = 'This number is not ready to take calls.';

interface PendingCall {
  graph: ScenarioGraph;
  languages: ScenarioLanguage[];
  languageModels: ScenarioLanguageModels;
  askLanguage: boolean;
  chosenLanguage: ScenarioLanguage | null;
  log: PhoneCallLog | null;
  promptWav: Array<Buffer | undefined>;
  abandon: ReturnType<typeof setTimeout> | null;
  scenarioId: string;
  startedById: string;
  expires: number;
}

/** Receives the call Twilio posts when someone dials the number, then opens the audio stream. */
@Injectable()
export class TelephonyService {
  private readonly logger = new Logger(TelephonyService.name);
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly streaming: PhoneStreamingService,
    private readonly speech: TextToSpeechService,
    private readonly hearing: SpeechToTextService,
    private readonly llm: LlmService,
    private readonly executions: ScenarioExecutionsService,
    private readonly config: ConfigService,
  ) {}

  async answer(input: { origin: string; path: string; params: Record<string, string>; signature: string | undefined }) {
    await this.assertTwilio(input);
    const callSid = input.params.CallSid?.trim();
    const to = input.params.To?.trim();
    if (!callSid || !to) throw new ForbiddenException('The request is missing CallSid or To.');
    const callId = await this.remember(callSid, input.params.From?.trim() || null, to);
    const scenario = await this.publishedScenario(to);
    if (!scenario) return sayTwiml(NOT_READY);
    await this.prisma.phoneCall.update({ where: { id: callId }, data: { scenarioId: scenario.id } });
    if (scenario.askLanguage && scenario.languages.some((code) => !scenario.languageModels[code]?.ttsModelId)) return sayTwiml(NOT_READY);
    await this.hold(callId, scenario);
    return this.streamFor(input.origin, callId);
  }

  async language(input: { origin: string; path: string; params: Record<string, string>; signature: string | undefined }) {
    await this.assertTwilio(input);
    const callSid = input.params.CallSid?.trim();
    const call = callSid ? await this.prisma.phoneCall.findUnique({ where: { callSid }, select: { id: true } }) : null;
    const pending = call ? this.pending.get(call.id) : undefined;
    const digit = input.params.Digits?.trim() ?? '';
    const chosen = digit && pending ? pending.languages[Number(digit) - 1] : undefined;
    this.logger.log(`Phone language key ${digit || 'none'}`);
    if (!call || !pending || !chosen) {
      if (pending?.abandon) clearTimeout(pending.abandon);
      if (pending?.log) await pending.log.finish(ExecutionStatus.STOPPED);
      if (call) this.pending.delete(call.id);
      return hangupTwiml();
    }
    pending.chosenLanguage = chosen;
    pending.expires = Date.now() + 60_000;
    return this.streamFor(input.origin, call.id);
  }

  async prompt(token: string, index: number) {
    const callId = readCallToken(this.secret(), token);
    const pending = callId ? this.pending.get(callId) : undefined;
    const language = pending?.languages[index];
    const modelId = language ? pending?.languageModels[language]?.ttsModelId : null;
    if (!pending || !language || !modelId || pending.expires < Date.now()) throw new NotFoundException('That prompt is not available.');
    const cached = pending.promptWav[index];
    if (cached) return cached;
    const log = pending.log ?? silentLog;
    const text = languageKeyLine(language, index);
    const started = log.now();
    const audio = await this.speech.speakPhone(modelId, text, log.context('language', 'step'));
    const samples = decodeUlaw(audio);
    log.agent(samples);
    await log.played({ nodeId: 'language', text, kind: 'step', startMs: started, endMs: log.now() });
    const wav = pcmWav(samples);
    pending.promptWav[index] = wav;
    return wav;
  }

  async openStream(socket: WebSocket, request: IncomingMessage) {
    const tokens = await this.streaming.authTokens();
    const signature = header(request, 'x-twilio-signature');
    const signed = tokens.some((token) => streamUrls(request).some((url) => isTwilioSignature(token, url, {}, signature)));
    if (!signed) {
      this.logger.warn('Refused a media stream with a bad Twilio signature.');
      socket.close(1008, 'The Twilio signature is not valid.');
      return;
    }
    const claimed = await this.claim(socket);
    if (!claimed) return;
    const { session, pending } = claimed;
    socket.on('message', (data) => session.receive(String(data)));
    socket.on('close', () => session.hangUp());
    const log = await this.openLog(pending);
    session.useLog(log);
    try {
      await session.run();
      const outcome = session.outcome();
      await log.finish(outcome.reachedEnd ? ExecutionStatus.FINISHED : ExecutionStatus.STOPPED);
    } catch (error) {
      this.logger.warn(`Phone scenario failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      await log.finish(ExecutionStatus.FAILED, error instanceof Error ? error.message : 'The call failed.');
    }
  }

  list() {
    return this.prisma.phoneCall.findMany({
      orderBy: { receivedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        callSid: true,
        fromNumber: true,
        toNumber: true,
        receivedAt: true,
        scenario: { select: { id: true, name: true } },
      },
    });
  }

  private claim(socket: WebSocket) {
    return new Promise<{ session: PhoneScenarioSession; pending: PendingCall } | null>((resolve) => {
      const timer = setTimeout(() => {
        socket.close(1008, 'The stream did not start.');
        resolve(null);
      }, 5000);
      const onMessage = (data: unknown) => {
        let message: { event?: string; start?: { customParameters?: Record<string, string> } };
        try {
          message = JSON.parse(String(data)) as typeof message;
        } catch {
          return;
        }
        if (message.event !== 'start') return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        const callId = readCallToken(this.secret(), message.start?.customParameters?.token ?? '');
        const pending = callId ? this.pending.get(callId) : undefined;
        if (!callId || !pending || pending.expires < Date.now()) {
          socket.close(1008, 'The stream token is not valid.');
          resolve(null);
          return;
        }
        if (pending.abandon) clearTimeout(pending.abandon);
        this.pending.delete(callId);
        const session = new PhoneScenarioSession(socket, pending.graph, this.deps(), silentLog, pending.languages, pending.languageModels, pending.askLanguage, pending.chosenLanguage);
        session.receive(String(data));
        resolve({ session, pending });
      };
      socket.on('message', onMessage);
    });
  }

  private async openLog(pending: PendingCall) {
    if (pending.log) return pending.log;
    try {
      const executionId = await this.executions.openPhone({
        scenarioId: pending.scenarioId,
        startedById: pending.startedById,
        graph: pending.graph,
      });
      return new PhoneCallLog(executionId, this.executions);
    } catch (error) {
      this.logger.warn(`Could not open a phone execution: ${error instanceof Error ? error.message : 'unknown error'}`);
      return silentLog;
    }
  }

  private async hold(callId: string, scenario: Awaited<ReturnType<TelephonyService['publishedScenario']>> & object) {
    let log: PhoneCallLog | null = null;
    if (scenario.askLanguage) {
      try {
        const executionId = await this.executions.openPhone({
          scenarioId: scenario.id,
          startedById: scenario.startedById,
          graph: scenario.graph,
        });
        log = new PhoneCallLog(executionId, this.executions);
      } catch (error) {
        this.logger.warn(`Could not open a phone execution: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    const pending: PendingCall = {
      graph: scenario.graph,
      languages: scenario.languages,
      languageModels: scenario.languageModels,
      askLanguage: scenario.askLanguage,
      chosenLanguage: null,
      log,
      promptWav: [],
      abandon: null,
      scenarioId: scenario.id,
      startedById: scenario.startedById,
      expires: Date.now() + 60_000,
    };
    if (log) {
      pending.abandon = setTimeout(() => {
        if (this.pending.get(callId) !== pending) return;
        this.pending.delete(callId);
        void log.finish(ExecutionStatus.STOPPED);
      }, 180_000);
    }
    this.pending.set(callId, pending);
    return pending;
  }

  private streamFor(origin: string, callId: string) {
    const streamUrl = `${origin.replace(/^http/, 'ws')}/telephony/twilio/stream`;
    return streamTwiml(streamUrl, mintCallToken(this.secret(), callId));
  }

  private async assertTwilio(input: { origin: string; path: string; params: Record<string, string>; signature: string | undefined }) {
    const tokens = await this.streaming.authTokens();
    if (tokens.length === 0) throw new ServiceUnavailableException(MISSING);
    const url = `${input.origin}${input.path}`;
    if (!tokens.some((token) => isTwilioSignature(token, url, input.params, input.signature))) {
      this.logger.warn(`Refused a Twilio webhook with a bad signature for ${url}`);
      throw new ForbiddenException('The Twilio signature is not valid.');
    }
  }

  private deps(): CallDeps {
    return {
      speak: (modelId, text, execution) => this.speech.speakPhone(modelId, text, execution),
      transcribe: async (modelId, wav, execution) => {
        const result = await this.hearing.transcribe(modelId, { buffer: wav, size: wav.length, mimetype: 'audio/wav', originalname: 'caller.wav' }, execution);
        return typeof result === 'string' ? result : result.text;
      },
      complete: async (modelId, input, execution) => {
        const turn = await this.llm.complete(modelId, input, execution);
        return { reply: turn.reply, inquiry: turn.inquiry, phase: turn.phase, topicId: turn.topicId };
      },
      judgeClosing: async (modelId, question, answer, execution) => {
        const result = await this.llm.judgeClosing(modelId, { question, answer }, execution);
        return result.outcome;
      },
      onDigit: (digit) => this.logger.log(`Phone digit ${digit}`),
    };
  }

  private async publishedScenario(to: string) {
    const number = await this.prisma.phoneNumber.findUnique({
      where: { e164: to },
      select: { scenario: { select: { id: true, active: true, graph: true, languages: true, languageModels: true, askLanguage: true, createdById: true } } },
    });
    if (!number?.scenario?.active) return null;
    const languages = number.scenario.languages.filter(isScenarioLanguage);
    return {
      id: number.scenario.id,
      startedById: number.scenario.createdById,
      languages,
      languageModels: languageModelsFor(languages, number.scenario.languageModels, false),
      askLanguage: number.scenario.askLanguage,
      graph: readScenarioGraph(number.scenario.graph),
    };
  }

  private secret() {
    return this.config.getOrThrow<string>('JWT_SECRET');
  }

  private async remember(callSid: string, fromNumber: string | null, toNumber: string) {
    try {
      const row = await this.prisma.phoneCall.create({ data: { callSid, fromNumber, toNumber }, select: { id: true } });
      return row.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const row = await this.prisma.phoneCall.findUniqueOrThrow({ where: { callSid }, select: { id: true } });
        return row.id;
      }
      throw error;
    }
  }
}

function header(request: IncomingMessage, name: string) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function streamUrls(request: IncomingMessage) {
  const host = header(request, 'x-forwarded-host') || header(request, 'host') || '';
  const path = request.url || '/telephony/twilio/stream';
  const urls = [`wss://${host}${path}`, `https://${host}${path}`];
  return [...urls, ...urls.map((url) => url.replace(/\/$/, ''))];
}
