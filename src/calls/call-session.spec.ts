import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeUlaw, ULAW_SILENCE } from '../common/audio/ulaw';
import { wavDurationMs } from '../common/audio/wav';
import { InquiryTurn } from '../llm/inquiry-turn';
import { SessionEnding, SessionEvent } from '../scenario-executions/scenario-executions.service';
import { parseScenarioGraph } from '../scenarios/scenario-graph';
import { FRAME_SAMPLES } from './call-timing';
import { CallChannel, CallServices, CallSession, TurnRequest } from './call-session';
import { OutboundMessage } from './call-transport';

const TTS = '11111111-1111-4111-8111-111111111111';
const STT = '22222222-2222-4222-8222-222222222222';
const LLM = '33333333-3333-4333-8333-333333333333';

const loudFrame = encodeUlaw(Int16Array.from({ length: FRAME_SAMPLES }, (_, index) => (index % 2 ? 6000 : -6000))).toString('base64');
const quietFrame = Buffer.alloc(FRAME_SAMPLES, ULAW_SILENCE).toString('base64');

function graphWith(options: { menu?: boolean; loop?: Record<string, unknown> } = {}) {
  const nodes: unknown[] = [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} },
    { id: 'greet', type: 'tts', position: { x: 0, y: 0 }, data: { modelId: TTS, text: 'Hello.' } },
    {
      id: 'loop',
      type: 'loop',
      position: { x: 0, y: 0 },
      data: { sttModelId: STT, ttsModelId: TTS, llmModelId: LLM, silenceSeconds: 1, fillers: ['One moment.'], sorryLine: 'Sorry.', maxTurns: 2, noInputSeconds: 5, ...options.loop },
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
    { id: 'hours-line', type: 'tts', position: { x: 0, y: 0 }, data: { modelId: TTS, text: 'We open at nine.' } },
    { id: 'callback-line', type: 'tts', position: { x: 0, y: 0 }, data: { modelId: TTS, text: 'An operator will call you back.' } },
    { id: 'end', type: 'end', position: { x: 0, y: 0 }, data: {} },
  ];
  const edges: unknown[] = [
    { id: 'e2', source: 'greet', target: 'loop' },
    { id: 'e3', source: 'loop', target: 'switch' },
    { id: 'e4', source: 'switch', sourceHandle: 'hours', target: 'hours-line' },
    { id: 'e5', source: 'switch', sourceHandle: 'default', target: 'callback-line' },
    { id: 'e6', source: 'hours-line', target: 'end' },
    { id: 'e7', source: 'callback-line', target: 'end' },
  ];
  if (options.menu) {
    nodes.push({
      id: 'menu',
      type: 'menu',
      position: { x: 0, y: 0 },
      data: {
        prompts: [{ ttsModelId: TTS, text: 'For Armenian press 1.' }],
        options: [
          { id: 'hy', key: '1', label: 'Armenian' },
          { id: 'en', key: '2', label: 'English' },
        ],
        defaultOptionId: 'hy',
        waitSeconds: 2,
        repeats: 1,
      },
    });
    edges.push(
      { id: 'e1', source: 'start', target: 'menu' },
      { id: 'e8', source: 'menu', sourceHandle: 'hy', target: 'greet' },
      { id: 'e9', source: 'menu', sourceHandle: 'en', target: 'end' },
    );
  } else {
    edges.push({ id: 'e1', source: 'start', target: 'greet' });
  }
  return parseScenarioGraph({ nodes, edges });
}

interface Harness {
  session: CallSession;
  sent: OutboundMessage[];
  events: Map<number, SessionEvent>;
  turns: TurnRequest[];
  clips: string[];
  recordings: Array<{ caller: Buffer; mix: Buffer; peaks: number[] }>;
  ending: () => SessionEnding | null;
  speak: (loudFrames: number, quietFrames: number) => void;
  key: (digit: string) => void;
  waitFor: (check: () => boolean, label: string) => Promise<void>;
  ofType: (type: string) => SessionEvent[];
}

function start(options: {
  graph: ReturnType<typeof graphWith>;
  channel?: CallChannel;
  turns?: InquiryTurn[];
  transcripts?: string[];
  failTranscribe?: boolean;
  markDelayMs?: number;
}): Harness {
  const sent: OutboundMessage[] = [];
  const events = new Map<number, SessionEvent>();
  const turns: TurnRequest[] = [];
  const clips: string[] = [];
  const recordings: Harness['recordings'] = [];
  let closed: SessionEnding | null = null;
  const replies = [...(options.turns ?? [])];
  const transcripts = [...(options.transcripts ?? [])];
  let session: CallSession | null = null;

  const services: CallServices = {
    async transcribe() {
      if (options.failTranscribe) throw new Error('HiSpeech is down.');
      return transcripts.shift() ?? 'What are your hours?';
    },
    async clip(_modelId, text, _context, signal) {
      if (signal.aborted) throw new Error('aborted');
      clips.push(text);
      return Buffer.alloc(800, ULAW_SILENCE);
    },
    async complete(_modelId, request, _context, signal) {
      turns.push(request);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (signal.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
      return replies.shift() ?? { reply: '', inquiry: 'Working hours', phase: 'accepted', topicId: 'hours' };
    },
    async describeLlm(modelId) {
      return { modelId, modelName: 'Fake' };
    },
    async writeEvents(batch) {
      for (const event of batch) events.set(event.seq, event);
    },
    async heartbeat() {},
    async storeRecordings(recording) {
      recordings.push(recording);
      return true;
    },
    async close(ending) {
      closed = ending;
    },
  };

  session = new CallSession({
    executionId: 'execution-1',
    graph: options.graph,
    channel: options.channel ?? 'BROWSER',
    services,
    createdAt: Date.now(),
    start: {},
    timing: { startPauseMs: 1, endPauseMs: 1, markGraceMs: 2000, heartbeatMs: 60_000, secondMs: 10 },
    transport: {
      send(message) {
        sent.push(message);
        if (message.event === 'mark') {
          const name = message.mark.name;
          setTimeout(() => session?.receive({ event: 'mark', mark: { name } }), options.markDelayMs ?? 2);
        }
      },
      close() {},
    },
  });

  const ofType = (type: string) => [...events.values()].filter((event) => event.type === type).sort((left, right) => left.seq - right.seq);
  return {
    session,
    sent,
    events,
    turns,
    clips,
    recordings,
    ending: () => closed,
    ofType,
    speak(loudFrames, quietFrames) {
      for (let index = 0; index < loudFrames; index += 1) session?.receive({ event: 'media', media: { payload: loudFrame } });
      for (let index = 0; index < quietFrames; index += 1) session?.receive({ event: 'media', media: { payload: quietFrame } });
    },
    key(digit) {
      session?.receive({ event: 'dtmf', dtmf: { digit } });
    },
    async waitFor(check, label) {
      const until = Date.now() + 3000;
      while (!check()) {
        if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

const progressSteps = (call: Harness) =>
  call.sent.flatMap((message) => (message.event === 'progress' && message.progress.kind === 'step' ? [message.progress.nodeId] : []));

test('an accepted inquiry routes to its topic and the call finishes', async () => {
  const call = start({ graph: graphWith() });
  await call.waitFor(() => progressSteps(call).includes('loop'), 'the loop');
  call.speak(30, 60);
  const outcome = await call.session.done;

  assert.equal(outcome.status, 'FINISHED');
  assert.equal(outcome.inquiry, 'Working hours');
  assert.equal(outcome.topicLabel, 'Working hours');
  assert.deepEqual(progressSteps(call), ['start', 'greet', 'loop', 'switch', 'hours-line', 'end']);
  assert.ok(call.clips.includes('We open at nine.'));
  assert.equal(call.turns[0]?.topics?.[0]?.id, 'hours');
  const ended = call.ofType('execution.ended')[0];
  assert.equal(ended?.payload.status, 'finished');
  assert.ok(call.ofType('tts.played').every((event) => typeof event.payload.endMs === 'number'), 'every spoken line has an end');
});

test('the turn limit ends the loop unresolved, takes Default, and marks a phone call for callback', async () => {
  const clarify: InquiryTurn = { reply: 'Could you say more?', inquiry: null, phase: 'clarify', topicId: 'default' };
  const call = start({ graph: graphWith({ loop: { maxTurns: 1 } }), channel: 'PHONE', turns: [clarify] });
  await call.waitFor(() => progressSteps(call).includes('loop') || call.ofType('node.entered').some((event) => event.nodeId === 'loop'), 'the loop');
  call.speak(30, 60);
  await call.waitFor(() => call.ofType('tts.played').some((event) => event.payload.kind === 'reply' && typeof event.payload.endMs === 'number'), 'the reply');
  call.speak(30, 60);
  const outcome = await call.session.done;

  assert.equal(outcome.status, 'FINISHED');
  assert.equal(outcome.callbackReason, 'TURN_LIMIT');
  assert.deepEqual(call.ofType('loop.unresolved').map((event) => event.payload.reason), ['TURN_LIMIT']);
  assert.deepEqual(call.ofType('callback.marked').map((event) => event.payload.reason), ['TURN_LIMIT']);
  assert.equal(call.ofType('switch.routed')[0]?.payload.usedFallback, true);
  assert.ok(call.clips.includes('An operator will call you back.'));
});

test('silence after the last audio ends the loop unresolved', async () => {
  const call = start({ graph: graphWith(), channel: 'PHONE' });
  const outcome = await call.session.done;
  assert.equal(outcome.callbackReason, 'SILENCE');
  assert.deepEqual(call.ofType('loop.unresolved').map((event) => event.payload.reason), ['SILENCE']);
  assert.equal(outcome.inquiry, null);
});

test('speech during a reply clears the audio, marks the reply interrupted, and tells the next turn', async () => {
  const clarify: InquiryTurn = { reply: 'Which branch do you mean?', inquiry: null, phase: 'clarify', topicId: 'default' };
  const call = start({ graph: graphWith(), turns: [clarify], markDelayMs: 400 });
  await call.waitFor(() => call.ofType('node.entered').some((event) => event.nodeId === 'loop'), 'the loop');
  call.speak(30, 60);
  await call.waitFor(() => call.ofType('tts.played').some((event) => event.payload.kind === 'reply'), 'the reply to start');
  call.speak(30, 60);
  const outcome = await call.session.done;

  assert.equal(outcome.status, 'FINISHED');
  assert.ok(call.sent.some((message) => message.event === 'clear'), 'clear was sent');
  const reply = call.ofType('tts.played').find((event) => event.payload.kind === 'reply');
  assert.equal(reply?.payload.interrupted, true);
  assert.deepEqual(call.ofType('barge_in').at(-1)?.payload, { during: 'reply', note: 'reply_cut_off' });
  const second = call.turns[1];
  assert.equal(second?.messages.find((message) => message.role === 'assistant' && message.content === 'Which branch do you mean?')?.interrupted, true);
  assert.match(second?.note ?? '', /interrupted while you were speaking/);
});

test('a provider failure in a loop plays the sorry line and fails the call', async () => {
  const call = start({ graph: graphWith(), channel: 'PHONE', failTranscribe: true });
  await call.waitFor(() => call.ofType('node.entered').some((event) => event.nodeId === 'loop'), 'the loop');
  call.speak(30, 60);
  const outcome = await call.session.done;

  assert.equal(outcome.status, 'FAILED');
  assert.equal(outcome.errorMessage, 'HiSpeech is down.');
  assert.equal(outcome.callbackReason, 'ERROR');
  assert.ok(call.ofType('tts.played').some((event) => event.payload.kind === 'sorry' && event.payload.text === 'Sorry.'));
});

test('a key during the menu prompt follows that option', async () => {
  const call = start({ graph: graphWith({ menu: true }), markDelayMs: 300 });
  await call.waitFor(() => call.ofType('tts.played').some((event) => event.payload.kind === 'menu'), 'the prompt');
  call.key('7');
  call.key('2');
  const outcome = await call.session.done;

  assert.equal(outcome.menuChoice, 'English');
  assert.deepEqual(
    call.ofType('key.pressed').map((event) => [event.payload.key, event.payload.accepted]),
    [
      ['7', false],
      ['2', true],
    ],
  );
  assert.equal(call.ofType('menu.chosen')[0]?.payload.usedDefault, false);
  assert.ok(call.sent.some((message) => message.event === 'clear'), 'the prompt stopped');
  assert.deepEqual(progressSteps(call), ['start', 'menu', 'end']);
});

test('no key plays the prompt again, then follows the default', async () => {
  const call = start({ graph: graphWith({ menu: true }) });
  await call.waitFor(() => call.ofType('menu.chosen').length > 0, 'the menu choice');
  call.session.hangUp();
  const outcome = await call.session.done;

  assert.equal(call.clips.filter((text) => text === 'For Armenian press 1.').length, 2);
  assert.deepEqual(call.ofType('menu.chosen')[0]?.payload, { optionId: 'hy', label: 'Armenian', key: null, usedDefault: true, promptsPlayed: 2 });
  assert.equal(outcome.status, 'STOPPED');
  assert.equal(outcome.menuChoice, 'Armenian');
});

test('the recordings start at zero and last as long as the call', async () => {
  const call = start({ graph: graphWith() });
  await call.waitFor(() => call.ofType('node.entered').some((event) => event.nodeId === 'loop'), 'the loop');
  call.speak(30, 60);
  const outcome = await call.session.done;
  const recording = call.recordings[0];
  assert.ok(recording);
  assert.equal(wavDurationMs(recording.mix), outcome.durationMs);
  assert.equal(wavDurationMs(recording.caller), wavDurationMs(recording.mix));
  assert.equal(recording.peaks.length, 240);
  assert.ok(recording.peaks.some((peak) => peak > 0.1), 'the caller is audible in the mix');
});
