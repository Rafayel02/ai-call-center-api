import { BadRequestException } from '@nestjs/common';

export interface RouteTopic {
  id: string;
  description: string;
}

export function topicRoutePrompt(inquiry: string | undefined, topics: RouteTopic[], defaultTopicId: string): string {
  const lines = [
    'You route a live phone call to one topic.',
    'Read the conversation and the agreed inquiry. Choose the topic that matches what the caller wants.',
    'If none of the topics match, choose the default topic.',
    '',
    `Agreed inquiry: ${inquiry?.trim() || 'Not yet agreed.'}`,
    '',
    'Topics:',
    ...topics.map((topic) => `- ${topic.id}: ${topic.description}`),
    `- ${defaultTopicId}: anything that does not match a topic above`,
    '',
    'Return JSON with topicId set to exactly one of those ids.',
  ];
  return lines.join('\n');
}

export function readTopicChoice(value: unknown, allowed: string[], defaultTopicId: string): string {
  const fallback = allowed.includes(defaultTopicId) ? defaultTopicId : allowed[0];
  if (!fallback) throw new BadRequestException('Choose a topic.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const topicId = (value as { topicId?: unknown }).topicId;
  if (typeof topicId === 'string' && allowed.includes(topicId)) return topicId;
  return fallback;
}
