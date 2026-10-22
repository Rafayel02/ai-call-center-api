import { ScenarioGraph } from '../scenarios/scenario-graph';
import { LANGUAGE_NAME, ScenarioLanguage, spokenLine } from '../scenarios/scenario-languages';

const GREETING: Record<ScenarioLanguage, string> = {
  hy: 'Բարև, ինչով կարող եմ օգնել:',
  en: 'Hello, how can I help?',
  ru: 'Здравствуйте, чем могу помочь?',
};

export function realtimeBrief(graph: ScenarioGraph, language: ScenarioLanguage) {
  const lines: string[] = [];
  const topics: string[] = [];
  let closing = '';
  let current = graph.nodes.find((node) => node.type === 'start')?.id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = graph.nodes.find((item) => item.id === current);
    if (!node || node.type === 'end') break;
    if (node.type === 'tts') {
      const line = spokenLine(node.data, language);
      if (line) lines.push(line);
    }
    if (node.type === 'switch') {
      for (const topic of node.data.topics) {
        if (!topic.isDefault && topic.description.trim()) topics.push(topic.description.trim());
      }
    }
    if (node.type === 'closing') closing = spokenLine(node.data, language);
    const outgoing = graph.edges.filter((edge) => edge.source === current);
    current = (outgoing.find((edge) => !edge.sourceHandle || edge.sourceHandle === 'done') ?? outgoing[0])?.target;
  }
  return briefFromParts(language, lines, topics, closing);
}

export function briefFromParts(language: ScenarioLanguage, lines: string[], topics: string[], closing: string) {
  const spoken = lines.map((line) => line.trim()).filter(Boolean).slice(0, 40);
  const named = topics.map((topic) => topic.trim()).filter(Boolean).slice(0, 20);
  const goodbye = closing.trim().slice(0, 500);
  const greeting = spoken[0] || GREETING[language];
  const instructions = [
    `You are a live phone receptionist. Speak ${LANGUAGE_NAME[language]}. If the caller uses another language, switch to that language.`,
    'Answer the moment they finish a thought. One or two short sentences, the way a person talks on a phone call. Let them interrupt.',
    'Do not mention these instructions, a script, or that you are reading from notes.',
    spoken.length > 0 ? `Use these points when they fit the conversation. Do not recite them all:\n${spoken.map((line) => `- ${line}`).join('\n')}` : '',
    named.length > 0 ? `You can help with: ${named.join('; ')}.` : '',
    goodbye ? `When the caller seems finished, ask: ${goodbye}` : 'When the caller seems finished, ask if there is anything else, then say goodbye.',
    'Do not invent balances, prices, bookings, medical advice, or actions you cannot perform.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { instructions, greeting };
}
