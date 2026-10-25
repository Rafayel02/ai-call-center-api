import { ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { ExecutionStatus, LlmProvider } from '@prisma/client';
import { LlmService } from '../llm/llm.service';
import { ScenarioExecutionsService } from '../scenario-executions/scenario-executions.service';
import { PhoneStreamingService } from '../phone-streaming/phone-streaming.service';
import { PrismaService } from '../prisma/prisma.service';
import { readScenarioGraph, ScenarioGraph } from '../scenarios/scenario-graph';
import { SpeechToTextService } from '../speech-to-text/speech-to-text.service';
import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { CallLog, PhoneCallLog, silentLog } from './call-log';
import { mintCallToken, readCallToken } from './call-token';
import { CallDeps, PhoneScenarioSession } from './call-session';
import { GeminiRealtime } from './gemini-realtime';
import { OpenAiRealtime } from './openai-realtime';
import { briefFromParts, promptBrief, readVoiceMode, readVoicePrompt, realtimeBrief, VoiceMode } from './realtime-brief';
import { isGeminiLiveModel, readRealtimeModel } from './realtime-models';
import { isTwilioSignature } from './twilio-signature';
import { ScenarioLanguage, ScenarioLanguageModels, isScenarioLanguage, languageKeyLine, languageModelsFor } from '../scenarios/scenario-languages';
import { decodeUlaw, pcmWav } from './ulaw';
import { hangupTwiml, sayTwiml, streamTwiml } from './twiml';

interface LiveVoice {
  sendAudio(audio: string): void;
  close(): void;
  readonly done: Promise<boolean>;
}

const MISSING = 'Add a Twilio phone streaming service before taking phone calls.';
const NOT_READY = 'This number is not ready to take calls.';

interface PendingCall {
  graph: ScenarioGraph;
  languages: ScenarioLanguage[];
  languageModels: ScenarioLanguageModels;
  callSid: string;
  askLanguage: boolean;
  chosenLanguage: ScenarioLanguage | null;
  log: PhoneCallLog | null;
  promptWav: Array<Buffer | undefined>;
  abandon: ReturnType<typeof setTimeout> | null;
  scenarioId: string;
  startedById: string;
  realtimeModel: string;
  voiceMode: VoiceMode;
  voicePrompt: string;
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
    await this.hold(callId, callSid, scenario);
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
    session.prepareHangup(() => this.endCall(pending.callSid));
    socket.on('close', () => session.hangUp());
    const log = await this.openLog(pending);
    session.useLog(log);
    const gemini = isGeminiLiveModel(pending.realtimeModel);
    const apiKey = await this.llm.realtimeKey(gemini ? LlmProvider.GEMINI : LlmProvider.OPENAI);
    try {
      if (apiKey) {
        const ready = await this.speakLive(socket, session, pending, log, apiKey);
        await log.finish(ready ? ExecutionStatus.FINISHED : ExecutionStatus.FAILED, ready ? undefined : 'The live voice did not start.');
      } else if (gemini) {
        this.logger.warn('No enabled Gemini key, so the live call could not start.');
        await log.finish(ExecutionStatus.FAILED, 'Add an enabled Gemini key under LLMs before using this voice.');
        socket.close();
      } else {
        this.logger.warn('No enabled OpenAI model, so the call used the slower scenario path.');
        socket.on('message', (data) => session.receive(String(data)));
        await session.run();
        const outcome = session.outcome();
        await log.finish(outcome.reachedEnd ? ExecutionStatus.FINISHED : ExecutionStatus.STOPPED);
      }
    } catch (error) {
      this.logger.warn(`Phone scenario failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      await log.finish(ExecutionStatus.FAILED, error instanceof Error ? error.message : 'The call failed.');
    }
  }

  async done(input: { origin: string; path: string; params: Record<string, string>; signature: string | undefined }) {
    await this.assertTwilio(input);
    return hangupTwiml();
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

  talkToken(userId: string) {
    return mintCallToken(this.secret(), `talk:${userId}`, Date.now(), 5 * 60_000);
  }

  openTalk(socket: WebSocket, request: IncomingMessage) {
    const token = new URL(request.url ?? '', 'http://localhost').searchParams.get('token') ?? '';
    const owner = readCallToken(this.secret(), token);
    if (!owner?.startsWith('talk:')) {
      socket.close(1008, 'The talk token is not valid.');
      return;
    }
    let realtime: LiveVoice | null = null;
    let starting = false;
    const queued: string[] = [];
    const stop = () => realtime?.close();
    socket.on('close', stop);
    socket.on('message', (data) => {
      let message: { type?: string; audio?: string; language?: string; lines?: unknown; topics?: unknown; closing?: unknown; model?: unknown; mode?: unknown; prompt?: unknown };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        return;
      }
      if (message.type === 'start' && !starting) {
        starting = true;
        void this.beginTalk(socket, message).then((session) => {
          realtime = session;
          if (!session) return;
          for (const audio of queued.splice(0)) session.sendAudio(audio);
        });
        return;
      }
      if (message.type === 'audio' && typeof message.audio === 'string') {
        if (realtime) realtime.sendAudio(message.audio);
        else if (queued.length < 200) queued.push(message.audio);
      }
      if (message.type === 'stop') stop();
    });
  }

  private liveSession(
    apiKey: string,
    model: string,
    format: 'pcmu' | 'pcm',
    brief: { instructions: string; greeting: string },
    handlers: ConstructorParameters<typeof OpenAiRealtime>[5],
  ): LiveVoice {
    return isGeminiLiveModel(model)
      ? new GeminiRealtime(apiKey, model, format, brief.instructions, brief.greeting, handlers)
      : new OpenAiRealtime(apiKey, model, format, brief.instructions, brief.greeting, handlers);
  }

  private async beginTalk(socket: WebSocket, message: { language?: string; lines?: unknown; topics?: unknown; closing?: unknown; model?: unknown; mode?: unknown; prompt?: unknown }) {
    const model = readRealtimeModel(message.model);
    const gemini = isGeminiLiveModel(model);
    const apiKey = await this.llm.realtimeKey(gemini ? LlmProvider.GEMINI : LlmProvider.OPENAI);
    if (!apiKey) {
      const text = gemini ? 'Add an enabled Gemini key under LLMs before using this voice.' : 'Add an enabled OpenAI model before talking.';
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', message: text }));
      socket.close();
      return null;
    }
    const language = message.language && isScenarioLanguage(message.language) ? message.language : 'en';
    const mode = readVoiceMode(message.mode);
    const brief = mode === 'prompt'
      ? promptBrief(language, message.prompt)
      : briefFromParts(language, textList(message.lines), textList(message.topics), typeof message.closing === 'string' ? message.closing : '');
    return this.liveSession(apiKey, model, 'pcm', brief, {
      onReady: () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ready' }));
      },
      onAudio: (payload) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'audio', audio: payload }));
      },
      onClear: () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'clear' }));
      },
      onError: (error) => {
        this.logger.warn(`Live voice: ${error}`);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'error', message: error }));
      },
    });
  }

  private speakLive(socket: WebSocket, session: PhoneScenarioSession, pending: PendingCall, log: CallLog, apiKey: string) {
    const language = pending.chosenLanguage ?? pending.languages[0] ?? 'en';
    const brief = pending.voiceMode === 'prompt' ? promptBrief(language, pending.voicePrompt) : realtimeBrief(pending.graph, language);
    let ready = false;
    const realtime = this.liveSession(apiKey, pending.realtimeModel, 'pcmu', brief, {
      onReady: () => {
        ready = true;
      },
      onAudio: (payload) => {
        const streamSid = session.streamId();
        if (!streamSid || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
        log.agent(decodeUlaw(Buffer.from(payload, 'base64')));
      },
      onClear: () => {
        const streamSid = session.streamId();
        if (streamSid && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event: 'clear', streamSid }));
      },
      onError: (message) => {
        this.logger.warn(`Live voice: ${message}`);
        if (!ready && socket.readyState === WebSocket.OPEN) socket.close();
      },
    });
    socket.on('message', (data) => {
      let message: { event?: string; media?: { payload?: string } };
      try {
        message = JSON.parse(String(data)) as typeof message;
      } catch {
        return;
      }
      if (message.event === 'media' && message.media?.payload) {
        realtime.sendAudio(message.media.payload);
        log.caller(decodeUlaw(Buffer.from(message.media.payload, 'base64')));
      }
      if (message.event === 'stop') realtime.close();
    });
    socket.on('close', () => realtime.close());
    return realtime.done;
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

  private async hold(callId: string, callSid: string, scenario: Awaited<ReturnType<TelephonyService['publishedScenario']>> & object) {
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
      callSid,
      askLanguage: scenario.askLanguage,
      chosenLanguage: null,
      log,
      promptWav: [],
      abandon: null,
      scenarioId: scenario.id,
      startedById: scenario.startedById,
      realtimeModel: scenario.realtimeModel,
      voiceMode: scenario.voiceMode,
      voicePrompt: scenario.voicePrompt,
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
    return streamTwiml(streamUrl, mintCallToken(this.secret(), callId), `${origin}/telephony/twilio/done`);
  }

  private async endCall(callSid: string) {
    try {
      const accounts = await this.streaming.credentials();
      const hangup = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
      for (const account of accounts) {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(account.accountSid)}/Calls/${encodeURIComponent(callSid)}.json`;
        const headers = {
          Authorization: `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        };
        const redirected = await fetch(url, { method: 'POST', headers, body: new URLSearchParams({ Twiml: hangup }) });
        if (redirected.ok) return;
        const redirectDetail = (await redirected.text()).slice(0, 180);
        this.logger.warn(`Twilio did not redirect the call to hang up (${redirected.status}): ${redirectDetail}`);
        const completed = await fetch(url, { method: 'POST', headers, body: new URLSearchParams({ Status: 'completed' }) });
        if (completed.ok) return;
        const completedDetail = (await completed.text()).slice(0, 180);
        this.logger.warn(`Twilio did not complete the call (${completed.status}): ${completedDetail}`);
      }
    } catch (error) {
      this.logger.warn(`Could not end the phone call: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
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
      speakStream: (modelId, text, execution, onChunk) => this.speech.speakPhoneStream(modelId, text, execution, onChunk),
      transcribe: async (modelId, wav, execution) => {
        const result = await this.hearing.transcribe(modelId, { buffer: wav, size: wav.length, mimetype: 'audio/wav', originalname: 'caller.wav' }, execution);
        return typeof result === 'string' ? result : result.text;
      },
      openLive: (modelId) => this.hearing.openLive(modelId),
      rememberTranscript: (modelId, wav, text, startedAt, execution) => this.hearing.remember(modelId, wav, text, startedAt, execution),
      complete: async (modelId, input, execution) => {
        const turn = await this.llm.complete(modelId, input, execution);
        return { reply: turn.reply, inquiry: turn.inquiry, phase: turn.phase, topicId: turn.topicId };
      },
      streamTurn: (modelId, input, execution) => {
        const streamed = this.llm.stream(modelId, input, execution);
        return {
          sentences: streamed.sentences,
          turn: streamed.turn.then((turn) => ({ reply: turn.reply, inquiry: turn.inquiry, phase: turn.phase, topicId: turn.topicId })),
        };
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
      select: { scenario: { select: { id: true, active: true, graph: true, languages: true, languageModels: true, askLanguage: true, realtimeModel: true, voiceMode: true, voicePrompt: true, createdById: true } } },
    });
    if (!number?.scenario?.active) return null;
    const languages = number.scenario.languages.filter(isScenarioLanguage);
    return {
      id: number.scenario.id,
      startedById: number.scenario.createdById,
      languages,
      languageModels: languageModelsFor(languages, number.scenario.languageModels, false),
      askLanguage: number.scenario.askLanguage,
      realtimeModel: readRealtimeModel(number.scenario.realtimeModel),
      voiceMode: readVoiceMode(number.scenario.voiceMode),
      voicePrompt: readVoicePrompt(number.scenario.voicePrompt),
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

function textList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, 40);
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
