// Both transports speak Twilio's media stream messages, so the session has one code path.

export type InboundMessage =
  | { event: 'connected' }
  | { event: 'start'; start: { callSid?: string; streamSid?: string; customParameters?: Record<string, string> } }
  | { event: 'media'; media: { payload: string } }
  | { event: 'dtmf'; dtmf: { digit: string } }
  | { event: 'mark'; mark: { name: string } }
  | { event: 'stop' };

/** What the session sends the browser besides audio, so the designer can follow the call. Phone calls drop it. */
export type CallProgress =
  | { kind: 'started'; executionId: string }
  | { kind: 'step'; nodeId: string }
  | { kind: 'caller'; text: string }
  | { kind: 'agent'; text: string; spoken: 'step' | 'reply' | 'delay' | 'menu' | 'sorry' }
  | { kind: 'inquiry'; inquiry: string; topicId: string | null }
  | { kind: 'topic'; topicId: string; label: string }
  | { kind: 'ended'; executionId: string; status: 'FINISHED' | 'STOPPED' | 'FAILED'; error: string | null; inquiry: string | null };

export type OutboundMessage =
  | { event: 'media'; media: { payload: string } }
  | { event: 'mark'; mark: { name: string } }
  | { event: 'clear' }
  | { event: 'progress'; progress: CallProgress };

export interface CallTransport {
  send(message: OutboundMessage): void;
  /** Ends the stream. For a phone call, Twilio then runs the TwiML after `<Connect>`. */
  close(): void;
}

/** Reads one WebSocket text frame. Returns null for anything that is not a known message. */
export function readInbound(raw: string): InboundMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  const part = (key: string) => (message[key] && typeof message[key] === 'object' ? (message[key] as Record<string, unknown>) : null);
  switch (message.event) {
    case 'connected':
    case 'stop':
      return { event: message.event };
    case 'start': {
      const start = part('start') ?? {};
      const params = start.customParameters && typeof start.customParameters === 'object' ? (start.customParameters as Record<string, unknown>) : {};
      const customParameters: Record<string, string> = {};
      for (const [key, item] of Object.entries(params)) if (typeof item === 'string') customParameters[key] = item;
      return {
        event: 'start',
        start: {
          callSid: typeof start.callSid === 'string' ? start.callSid : undefined,
          streamSid: typeof start.streamSid === 'string' ? start.streamSid : undefined,
          customParameters,
        },
      };
    }
    case 'media': {
      const payload = part('media')?.payload;
      return typeof payload === 'string' ? { event: 'media', media: { payload } } : null;
    }
    case 'dtmf': {
      const digit = part('dtmf')?.digit;
      return typeof digit === 'string' ? { event: 'dtmf', dtmf: { digit } } : null;
    }
    case 'mark': {
      const name = part('mark')?.name;
      return typeof name === 'string' ? { event: 'mark', mark: { name } } : null;
    }
    default:
      return null;
  }
}
