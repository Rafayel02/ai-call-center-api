export const REALTIME_MODELS = [
  { id: 'gpt-realtime-1.5', label: 'GPT Realtime 1.5' },
  { id: 'gpt-realtime-2', label: 'GPT Realtime 2' },
  { id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1' },
  { id: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 Mini' },
  { id: 'gpt-realtime', label: 'GPT Realtime — Armenian listed' },
  { id: 'gpt-realtime-mini', label: 'GPT Realtime Mini — Armenian listed' },
  { id: 'gemini-3.8-live', label: 'Gemini 3.8 Live' },
  { id: 'gemini-2.5-flash-native-audio-preview-12-2025', label: 'Gemini 2.5 Live — Armenian listed' },
] as const;

export const DEFAULT_REALTIME_MODEL = 'gpt-realtime';

const IDS = REALTIME_MODELS.map((model) => model.id);

export function readRealtimeModel(value: unknown) {
  return typeof value === 'string' && (IDS as readonly string[]).includes(value) ? value : DEFAULT_REALTIME_MODEL;
}

export function isGeminiLiveModel(value: string) {
  return value.startsWith('gemini-');
}
