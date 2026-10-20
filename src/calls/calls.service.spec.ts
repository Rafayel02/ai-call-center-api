/**
 * Runs against the test database: npm run test:db
 *
 * The real services run browser and phone calls end to end over WebSockets. Only the providers are fake:
 * ElevenLabs, Scribe, and OpenAI. Twilio is played by a WebSocket client that signs like Twilio.
 */
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { createServer, Server } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { encodeUlaw, ULAW_SILENCE } from '../common/audio/ulaw';
import { LlmService } from '../llm/llm.service';
import { ProviderRegistry as LlmRegistry } from '../llm/providers/provider.registry';
import { PrismaService } from '../prisma/prisma.service';
import { ScenarioExecutionsService, STALE_MESSAGE } from '../scenario-executions/scenario-executions.service';
import { ScenariosService } from '../scenarios/scenarios.service';
import { ProviderRegistry as SttRegistry } from '../speech-to-text/providers/provider.registry';
import { SpeechToTextService } from '../speech-to-text/speech-to-text.service';
import { TelephonyService } from '../telephony/telephony.service';
import { twilioSignature } from '../telephony/twilio-signature';
import { TtsProviderRegistry } from '../text-to-speech/providers/provider.registry';
import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { CallRecordsService } from './call-records.service';
import { attachCallStreams } from './call-streams';
import { FRAME_SAMPLES } from './call-timing';
import { CallsService } from './calls.service';

Logger.overrideLogger(false);
const prisma = new PrismaService();
const spoken: Array<{ text: string; format: string }> = [];
const TWILIO_TOKEN = 'twilio-auth-token-for-the-call-tests';
const NUMBER = '+15551234567';

const ttsProvider = {
  id: 'ELEVENLABS',
  toPublic: () => ({ modelId: 'eleven_v3', voiceId: 'voice-12345678', voiceName: 'Test voice' }),
  async speak(_config: unknown, text: string, format: string) {
    spoken.push({ text, format });
    return Buffer.alloc(800, ULAW_SILENCE);
  },
};
const sttProvider = {
  id: 'ELEVENLABS',
  toPublic: () => ({ modelId: 'scribe_v1', languageCode: 'eng', apiKeyHint: '1234' }),
  async transcribe() {
    return { text: 'What are your hours?', languageCode: 'eng' };
  },
};
const llmProvider = {
  id: 'OPENAI',
  toPublic: () => ({ modelId: 'gpt-4o-mini', apiKeyHint: '1234' }),
  async complete() {
    return {
      turn: { reply: '', inquiry: 'Working hours', phase: 'accepted' as const, topicId: 'hours' },
      trace: { systemPrompt: 'prompt', messages: [], raw: {}, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, latencyMs: 3 },
    };
  },
};
const registry = (provider: unknown) => ({ get: () => provider, list: () => [] });

process.env.CALL_TOKEN_SECRET = 'a-long-random-secret-for-the-call-tests';
process.env.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
const config = new ConfigService();
const executions = new ScenarioExecutionsService(prisma);
const textToSpeech = new TextToSpeechService(prisma, registry(ttsProvider) as unknown as TtsProviderRegistry, executions);
const scenarios = new ScenariosService(prisma, textToSpeech);
const records = new CallRecordsService(prisma, executions);
const calls = new CallsService(
  config,
  scenarios,
  executions,
  records,
  new SpeechToTextService(prisma, registry(sttProvider) as unknown as SttRegistry, executions),
  textToSpeech,
  new LlmService(prisma, registry(llmProvider) as unknown as LlmRegistry, executions),
);
const telephony = new TelephonyService(config, calls);

let server: Server;
let ownerId = '';
let scenarioId = '';
let models = { tts: '', stt: '', llm: '' };

function graph(loop: Record<string, unknown> = {}) {
  return {
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
      { id: 'greet', type: 'tts', position: { x: 0, y: 0 }, data: { modelId: models.tts, text: 'Hello.' } },
      {
        id: 'loop',
        type: 'loop',
        position: { x: 0, y: 0 },
        data: { sttModelId: models.stt, ttsModelId: models.tts, llmModelId: models.llm, silenceSeconds: 1, fillers: ['One moment.'], sorryLine: 'Sorry.', ...loop },
      },
      {
        id: 'switch',
        type: 'switch',
        position: { x: 0, y: 0 },
        data: {
          topics: [
            { id: 'default', description: '', isDefault: true },
            { id: 'hours', description: 'Working hours', isDefault: false },
          ],
        },
      },
      { id: 'hours-line', type: 'tts', position: { x: 0, y: 0 }, data: { modelId: models.tts, text: 'We open at nine.' } },
      { id: 'end', type: 'end', position: { x: 0, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'greet' },
      { id: 'e2', source: 'greet', target: 'loop' },
      { id: 'e3', source: 'loop', target: 'switch' },
      { id: 'e4', source: 'switch', sourceHandle: 'hours', target: 'hours-line' },
      { id: 'e5', source: 'switch', sourceHandle: 'default', target: 'end' },
      { id: 'e6', source: 'hours-line', target: 'end' },
    ],
  };
}

const loud = encodeUlaw(Int16Array.from({ length: FRAME_SAMPLES }, (_, index) => (index % 2 ? 6000 : -6000))).toString('base64');
const quiet = Buffer.alloc(FRAME_SAMPLES, ULAW_SILENCE).toString('base64');

interface Received {
  event: string;
  streamSid?: string;
  mark?: { name: string };
  progress?: Record<string, unknown>;
}

/**
 * A call client: sends `start` with the token, answers every mark, and speaks once. The browser speaks when the
 * loop starts; a phone client after its first mark, because Twilio gets no progress messages. Resolves on close.
 */
function client(input: { url: string; token: string; callId?: string; headers?: Record<string, string>; hangUpAfterFirstMark?: boolean }) {
  return new Promise<{ code: number; received: Received[] }>((resolve, reject) => {
    const ws = new WebSocket(input.url, { headers: input.headers });
    const received: Received[] = [];
    let spokeUp = false;
    const send = (message: object) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(message));
    const speak = () => {
      if (spokeUp) return;
      spokeUp = true;
      for (let index = 0; index < 30; index += 1) send({ event: 'media', media: { payload: loud } });
      for (let index = 0; index < 60; index += 1) send({ event: 'media', media: { payload: quiet } });
    };
    ws.on('open', () => {
      send({ event: 'connected' });
      send({
        event: 'start',
        start: { streamSid: 'MZtest', callSid: 'CAtest', customParameters: { token: input.token, ...(input.callId ? { callId: input.callId } : {}) } },
      });
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Received;
      received.push(message);
      if (message.event === 'mark' && message.mark) {
        const name = message.mark.name;
        if (input.hangUpAfterFirstMark) {
          send({ event: 'stop' });
          return;
        }
        setTimeout(() => send({ event: 'mark', mark: { name } }), 5);
        if (!input.callId) return;
        setTimeout(speak, 200);
      }
      if (message.event === 'progress' && message.progress?.kind === 'step' && message.progress.nodeId === 'loop') speak();
    });
    ws.on('close', (code) => resolve({ code, received }));
    ws.on('error', reject);
  });
}

function base() {
  return process.env.PUBLIC_BASE_URL ?? '';
}

/** Twilio's voice webhook, signed as Twilio signs it. */
function webhook(params: Record<string, string>, signature?: string) {
  const path = '/telephony/twilio/voice';
  return telephony.answer({ path, params, signature: signature ?? twilioSignature(TWILIO_TOKEN, `${base()}${path}`, params) });
}

function streamOf(twiml: string) {
  const url = /<Stream url="([^"]+)"/.exec(twiml)?.[1] ?? '';
  const callId = /name="callId" value="([^"]+)"/.exec(twiml)?.[1] ?? '';
  const token = /name="token" value="([^"]+)"/.exec(twiml)?.[1] ?? '';
  return { url, callId, token, signature: twilioSignature(TWILIO_TOKEN, url) };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string) {
  const until = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function addNumber() {
  await scenarios.setActive(scenarioId, true);
  await prisma.phoneNumber.create({ data: { e164: NUMBER, scenarioId } });
}

before(async () => {
  server = createServer();
  attachCallStreams(server, calls, { verifyTwilio: (request) => telephony.verifyStreamHandshake(request) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  spoken.length = 0;
  calls.streamStartLimitMs = 60_000;
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" CASCADE');
  const owner = await prisma.user.create({ data: { email: 'owner@example.com', passwordHash: 'x' } });
  ownerId = owner.id;
  const organization = await prisma.organization.create({ data: { name: 'Test', nameKey: 'test', createdById: owner.id } });
  const shared = { config: {}, createdById: owner.id };
  models = {
    tts: (await prisma.textToSpeechModel.create({ data: { ...shared, name: 'Voice', provider: 'ELEVENLABS' } })).id,
    stt: (await prisma.speechToTextModel.create({ data: { ...shared, name: 'Scribe', provider: 'ELEVENLABS' } })).id,
    llm: (await prisma.llmModel.create({ data: { ...shared, name: 'GPT', provider: 'OPENAI' } })).id,
  };
  const scenario = await prisma.scenario.create({
    data: { organizationId: organization.id, name: 'Calls', icon: 'audio', graph: graph(), createdById: owner.id },
  });
  scenarioId = scenario.id;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('a browser call runs on the server and is recorded as an execution', async () => {
  const started = await calls.startBrowserCall({ scenarioId, graph: graph(), userId: ownerId });
  const { code, received } = await client({ url: started.streamUrl, token: started.token });
  assert.equal(code, 1000);
  assert.deepEqual(received.filter((message) => message.event === 'progress').at(-1)?.progress, {
    kind: 'ended',
    executionId: started.executionId,
    status: 'FINISHED',
    error: null,
    inquiry: 'Working hours',
  });
  assert.ok(received.every((message) => message.streamSid === undefined), 'the browser gets no stream id');

  const execution = await executions.get(started.executionId);
  assert.equal(execution.status, 'FINISHED');
  assert.equal(execution.channel, 'BROWSER');
  assert.equal(execution.startedBy?.email, 'owner@example.com');
  assert.equal(execution.call, null);
  assert.equal(execution.inquiry, 'Working hours');
  assert.equal(execution.topicLabel, 'Working hours');
  assert.equal(execution.hasMix, true);
  assert.equal(execution.peaks?.length, 240);

  const types = execution.events.map((event) => event.type);
  for (const type of ['stream.started', 'node.entered', 'tts.ready', 'tts.played', 'stt.completed', 'llm.completed', 'inquiry.accepted', 'switch.routed', 'execution.ended']) {
    assert.ok(types.includes(type), `records ${type}`);
  }
  const ready = execution.events.find((event) => event.type === 'tts.ready');
  assert.equal(ready?.payload.durationMs, 100);
  assert.equal(typeof ready?.payload.audioUrl, 'string');
  assert.deepEqual(
    execution.segments.map((segment) => [segment.speaker, segment.kind, segment.text]),
    [
      ['agent', 'step', 'Hello.'],
      ['caller', null, 'What are your hours?'],
      ['agent', 'delay', 'One moment.'],
      ['agent', 'step', 'We open at nine.'],
    ],
  );

  const audio = await prisma.scenarioExecutionAudio.findMany({ where: { executionId: started.executionId }, select: { kind: true, mimeType: true } });
  assert.deepEqual([...new Set(audio.map((row) => row.kind))].sort(), ['CALLER', 'MIX', 'TTS', 'UTTERANCE']);
  assert.ok(audio.every((row) => row.mimeType === 'audio/wav'));
  assert.ok(spoken.every((line) => line.format === 'ulaw_8000'));
});

test('a call token works once, only on its own stream, and a forged one closes the stream', async () => {
  const started = await calls.startBrowserCall({ scenarioId, graph: graph(), userId: ownerId });
  const twilioUrl = started.streamUrl.replace('/calls/browser/stream', '/telephony/twilio/stream');
  const wrongStream = await client({ url: twilioUrl, token: started.token, headers: { 'x-twilio-signature': twilioSignature(TWILIO_TOKEN, twilioUrl) } });
  assert.equal(wrongStream.code, 4401);
  const first = client({ url: started.streamUrl, token: started.token });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await client({ url: started.streamUrl, token: started.token })).code, 4401);
  await first;
  assert.equal((await client({ url: started.streamUrl, token: 'forged.token.value' })).code, 4401);
});

test('Play refuses a graph a call cannot run', async () => {
  await assert.rejects(calls.startBrowserCall({ scenarioId, graph: graph({ sorryLine: '' }), userId: ownerId }), /Add a sorry line/);
});

test('publishing renders every fixed line once as a phone clip', async () => {
  await scenarios.setActive(scenarioId, true);
  const lines = spoken.map((line) => `${line.format}:${line.text}`).sort();
  assert.deepEqual(lines, ['ulaw_8000:Hello.', 'ulaw_8000:One moment.', 'ulaw_8000:Sorry.', 'ulaw_8000:We open at nine.']);
  await scenarios.setActive(scenarioId, false);
  await scenarios.setActive(scenarioId, true);
  assert.equal(spoken.length, 4, 'a second publish reuses the stored clips');
  const clip = await prisma.textToSpeechClip.findFirst({ where: { text: 'Hello.' }, select: { mimeType: true } });
  assert.equal(clip?.mimeType, 'audio/x-mulaw');
});

test('a phone call to a published number streams to its scenario and closes its call row', async () => {
  await addNumber();
  const twiml = await webhook({ CallSid: 'CA100', From: '+37491000000', To: NUMBER });
  const stream = streamOf(twiml);
  assert.equal(stream.url, `${base().replace(/^http/, 'ws')}/telephony/twilio/stream`);
  assert.match(twiml, /<Connect><Stream url=".+"><Parameter name="callId"/);
  assert.match(twiml, /<\/Connect><Hangup\/><\/Response>$/);

  const { code, received } = await client({ url: stream.url, token: stream.token, callId: stream.callId, headers: { 'x-twilio-signature': stream.signature } });
  assert.equal(code, 1000);
  assert.ok(received.length > 0 && received.every((message) => message.streamSid === 'MZtest'), 'every message to Twilio names the stream');
  assert.ok(received.every((message) => message.event !== 'progress'), 'Twilio gets no progress messages');

  const row = await waitFor(
    () => prisma.call.findUniqueOrThrow({ where: { id: stream.callId } }),
    (call) => call.endReason !== null,
    'the call row to close',
  );
  assert.equal(row.endReason, 'COMPLETED');
  assert.equal(row.fromNumber, '+37491000000');
  assert.equal(row.callbackReason, null);
  const execution = await executions.get(row.executionId ?? '');
  assert.equal(execution.channel, 'PHONE');
  assert.equal(execution.startedBy, null);
  assert.equal(execution.status, 'FINISHED');
  assert.deepEqual(execution.call, { fromNumber: '+37491000000', toNumber: NUMBER, endReason: 'COMPLETED', callbackReason: null, calledBackAt: null, calledBackBy: null });
  assert.equal(execution.events.find((event) => event.type === 'stream.started')?.payload.callSid, 'CAtest');
  const listed = await records.list({});
  assert.equal(listed.items[0]?.scenario?.id, scenarioId);
  assert.equal(listed.items[0]?.inquiry, 'Working hours');
});

test('a caller who hangs up ends the call as hung up, without a callback', async () => {
  await addNumber();
  const stream = streamOf(await webhook({ CallSid: 'CA200', From: '+37491000001', To: NUMBER }));
  await client({ url: stream.url, token: stream.token, callId: stream.callId, headers: { 'x-twilio-signature': stream.signature }, hangUpAfterFirstMark: true });
  const row = await waitFor(() => prisma.call.findUniqueOrThrow({ where: { id: stream.callId } }), (call) => call.endReason !== null, 'the call row');
  assert.equal(row.endReason, 'CALLER_HUNG_UP');
  assert.equal(row.callbackReason, null);
  assert.equal((await executions.get(row.executionId ?? '')).status, 'STOPPED');
});

test('an unknown number stores only a NO_SCENARIO row and hangs up', async () => {
  const twiml = await webhook({ CallSid: 'CA300', From: '+37491000002', To: '+15550000000' });
  assert.match(twiml, /<Response><Hangup\/><\/Response>$/);
  const row = await prisma.call.findUniqueOrThrow({ where: { providerCallId: 'CA300' } });
  assert.equal(row.endReason, 'NO_SCENARIO');
  assert.equal(row.executionId, null);
  assert.ok(row.endedAt);
  assert.equal(await prisma.scenarioExecution.count(), 0);
});

test('a bad Twilio signature is refused on the webhook and on the stream', async () => {
  await addNumber();
  await assert.rejects(webhook({ CallSid: 'CA400', To: NUMBER }, 'not-the-signature'), /signature is not valid/);
  assert.equal(await prisma.call.count(), 0);
  const stream = streamOf(await webhook({ CallSid: 'CA401', To: NUMBER }));
  await assert.rejects(client({ url: stream.url, token: stream.token, callId: stream.callId, headers: { 'x-twilio-signature': 'forged' } }), /403/);
});

test('a phone stream that never starts ends the execution and the call row', async () => {
  await addNumber();
  calls.streamStartLimitMs = 100;
  const stream = streamOf(await webhook({ CallSid: 'CA500', To: NUMBER }));
  const row = await waitFor(() => prisma.call.findUniqueOrThrow({ where: { id: stream.callId } }), (call) => call.endReason !== null, 'the call row');
  assert.equal(row.endReason, 'ERROR');
  assert.equal(row.error, 'The media stream did not connect.');
  const execution = await executions.get(row.executionId ?? '');
  assert.equal(execution.status, 'FAILED');
  assert.equal(execution.errorMessage, 'The media stream did not connect.');
});

test('a scenario that a number uses cannot be unpublished', async () => {
  await addNumber();
  await assert.rejects(scenarios.setActive(scenarioId, false), /Move \+15551234567 to another scenario first/);
});

test('the Callbacks page lists marked calls until someone calls back', async () => {
  const marked = await prisma.call.create({ data: { providerCallId: 'CA600', toNumber: NUMBER, fromNumber: '+37491000003', callbackReason: 'SILENCE', endReason: 'COMPLETED', endedAt: new Date() } });
  const plain = await prisma.call.create({ data: { providerCallId: 'CA601', toNumber: NUMBER, endReason: 'COMPLETED', endedAt: new Date() } });
  assert.deepEqual((await records.callbacks()).map((call) => call.id), [marked.id]);
  const done = await records.markCalledBack(marked.id, ownerId);
  assert.equal(done.calledBackBy?.email, 'owner@example.com');
  assert.deepEqual(await records.callbacks(), []);
  await assert.rejects(records.markCalledBack(plain.id, ownerId), /not waiting for a callback/);
});

test('the 2-minute rule closes a dead phone call and marks it for callback', async () => {
  const execution = await prisma.scenarioExecution.create({
    data: { id: crypto.randomUUID(), scenarioId, channel: 'PHONE', graph: graph(), lastActivityAt: new Date(Date.now() - 3 * 60 * 1000) },
  });
  await prisma.call.create({ data: { providerCallId: 'CA700', toNumber: NUMBER, executionId: execution.id } });
  await records.list({});
  const row = await prisma.call.findUniqueOrThrow({ where: { providerCallId: 'CA700' } });
  assert.equal(row.endReason, 'ERROR');
  assert.equal(row.callbackReason, 'ERROR');
  assert.equal(row.error, STALE_MESSAGE);
  assert.equal((await executions.get(execution.id)).status, 'FAILED');
});
