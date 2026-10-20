/**
 * Runs against the test database: npm run test:db
 *
 * The real services run a browser call end to end over a WebSocket. Only the providers are fake: ElevenLabs,
 * Scribe, and OpenAI.
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
import { ScenarioExecutionsService } from '../scenario-executions/scenario-executions.service';
import { ScenariosService } from '../scenarios/scenarios.service';
import { ProviderRegistry as SttRegistry } from '../speech-to-text/providers/provider.registry';
import { SpeechToTextService } from '../speech-to-text/speech-to-text.service';
import { TtsProviderRegistry } from '../text-to-speech/providers/provider.registry';
import { TextToSpeechService } from '../text-to-speech/text-to-speech.service';
import { attachCallStreams, BROWSER_STREAM_PATH } from './call-streams';
import { FRAME_SAMPLES } from './call-timing';
import { CallsService } from './calls.service';

Logger.overrideLogger(false);
const prisma = new PrismaService();
const spoken: Array<{ text: string; format: string }> = [];

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
const executions = new ScenarioExecutionsService(prisma);
const textToSpeech = new TextToSpeechService(prisma, registry(ttsProvider) as unknown as TtsProviderRegistry, executions);
const scenarios = new ScenariosService(prisma, textToSpeech);
const calls = new CallsService(
  new ConfigService(),
  scenarios,
  executions,
  new SpeechToTextService(prisma, registry(sttProvider) as unknown as SttRegistry, executions),
  textToSpeech,
  new LlmService(prisma, registry(llmProvider) as unknown as LlmRegistry, executions),
);

let server: Server;
let streamUrl = '';
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

/** Plays the browser: sends start, answers marks, speaks once when the loop starts. Resolves with the close code. */
function browser(token: string) {
  return new Promise<{ code: number; progress: Array<Record<string, unknown>> }>((resolve, reject) => {
    const ws = new WebSocket(streamUrl);
    const progress: Array<Record<string, unknown>> = [];
    let spokeUp = false;
    ws.on('open', () => ws.send(JSON.stringify({ event: 'start', start: { customParameters: { token } } })));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { event: string; mark?: { name: string }; progress?: Record<string, unknown> };
      if (message.event === 'mark' && message.mark) {
        const name = message.mark.name;
        setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ event: 'mark', mark: { name } })), 5);
      }
      if (message.event === 'progress' && message.progress) {
        progress.push(message.progress);
        if (message.progress.kind === 'step' && message.progress.nodeId === 'loop' && !spokeUp) {
          spokeUp = true;
          for (let index = 0; index < 30; index += 1) ws.send(JSON.stringify({ event: 'media', media: { payload: loud } }));
          for (let index = 0; index < 60; index += 1) ws.send(JSON.stringify({ event: 'media', media: { payload: quiet } }));
        }
      }
    });
    ws.on('close', (code) => resolve({ code, progress }));
    ws.on('error', reject);
  });
}

before(async () => {
  server = createServer();
  attachCallStreams(server, calls);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  streamUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${BROWSER_STREAM_PATH}`;
});

beforeEach(async () => {
  spoken.length = 0;
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users" CASCADE');
  const owner = await prisma.user.create({ data: { email: 'owner@example.com', passwordHash: 'x' } });
  ownerId = owner.id;
  const organization = await prisma.organization.create({ data: { name: 'Test', nameKey: 'test', createdById: owner.id } });
  const base = { config: {}, createdById: owner.id };
  models = {
    tts: (await prisma.textToSpeechModel.create({ data: { ...base, name: 'Voice', provider: 'ELEVENLABS' } })).id,
    stt: (await prisma.speechToTextModel.create({ data: { ...base, name: 'Scribe', provider: 'ELEVENLABS' } })).id,
    llm: (await prisma.llmModel.create({ data: { ...base, name: 'GPT', provider: 'OPENAI' } })).id,
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
  const { code, progress } = await browser(started.token);
  assert.equal(code, 1000);
  assert.deepEqual(progress.at(-1), { kind: 'ended', executionId: started.executionId, status: 'FINISHED', error: null, inquiry: 'Working hours' });

  const execution = await executions.get(started.executionId);
  assert.equal(execution.status, 'FINISHED');
  assert.equal(execution.channel, 'BROWSER');
  assert.equal(execution.startedBy?.email, 'owner@example.com');
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

test('a call token works once, and a forged one closes the stream', async () => {
  const started = await calls.startBrowserCall({ scenarioId, graph: graph(), userId: ownerId });
  const first = browser(started.token);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await browser(started.token)).code, 4401);
  await first;
  assert.equal((await browser('forged.token.value')).code, 4401);
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
