export type DemoRoute =
  | { kind: 'model'; modelId: string }
  | { kind: 'talk-token' }
  | { kind: 'create-execution' }
  | { kind: 'execution'; executionId: string };

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export function demoRoute(method: string, rawPath: string): DemoRoute | null {
  if (method.toUpperCase() !== 'POST') return null;
  const path = rawPath.split('?')[0] || '/';
  const speak = path.match(new RegExp(`^/text-to-speech-models/(${UUID})/speak$`));
  if (speak?.[1]) return { kind: 'model', modelId: speak[1] };
  const transcribe = path.match(new RegExp(`^/speech-to-text-models/(${UUID})/transcribe$`));
  if (transcribe?.[1]) return { kind: 'model', modelId: transcribe[1] };
  const complete = path.match(new RegExp(`^/llm-models/(${UUID})/(?:complete|closing)$`));
  if (complete?.[1]) return { kind: 'model', modelId: complete[1] };
  if (path === '/telephony/talk-token') return { kind: 'talk-token' };
  if (path === '/scenario-executions') return { kind: 'create-execution' };
  const execution = path.match(new RegExp(`^/scenario-executions/(${UUID})/(?:events|heartbeat|finish|audio)$`));
  if (execution?.[1]) return { kind: 'execution', executionId: execution[1] };
  return null;
}

export function demoBearer(header: string | undefined) {
  if (!header?.startsWith('Bearer demo_')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.startsWith('demo_') ? token : null;
}
