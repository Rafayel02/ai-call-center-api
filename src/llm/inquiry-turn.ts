import { BadRequestException } from '@nestjs/common';

export const INQUIRY_PHASES = ['clarify', 'confirm', 'accepted'] as const;

export type InquiryPhase = (typeof INQUIRY_PHASES)[number];

export interface InquiryTurn {
  reply: string;
  inquiry: string | null;
  phase: InquiryPhase;
  topicId: string | null;
}

export interface PromptTopic {
  id: string;
  description: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  interrupted?: boolean;
}

export function inquirySystemPrompt(note?: string, topics?: PromptTopic[], defaultTopicId?: string, verify = true): string {
  const lines = [
    'You are on a live phone call. Your only job is to agree with the caller on what their inquiry is. You do not answer the inquiry.',
    '',
    'Do not answer their question. Do not search, look up, or supply facts such as an address, location, hours, price, policy, or status. The inquiry is what they want, not the answer to it.',
    verify
      ? 'Example: if the caller asks where the office is, the inquiry is "the office location" and the reply is "So you want the office location?" Do not give the address.'
      : 'Example: if the caller asks where the office is, the inquiry is "the office location". Accept it on this turn. Do not give the address and do not ask them to confirm.',
    '',
    'The messages may already include lines spoken in earlier steps. Do not greet again if a greeting was already spoken, and do not greet if the caller does not greet. Do not repeat lines that were already said. Continue from the latest turn.',
    '',
    'phase "clarify": you still need information. reply is one short follow-up question about what they want, not the answer. inquiry is your best partial statement, or null.',
  ];
  if (verify) {
    lines.push(
      'phase "confirm": you can state the inquiry. inquiry is that statement. reply must ask the caller to confirm it, in the form "So you want {inquiry}?" This is not the end of the call.',
      'phase "accepted": use this only after the caller clearly agrees with the confirmation question you just asked. reply is a short acknowledgement such as "Okay." inquiry is the confirmed statement.',
      '',
      'If the caller refuses or corrects you, do not use accepted. Use clarify, or confirm again with the corrected inquiry.',
      'Speak only through reply. Keep reply short enough to say aloud.',
    );
  } else {
    lines.push(
      'Do not use phase "confirm". Do not ask the caller to confirm, and do not repeat their inquiry back to them.',
      'phase "accepted": use this as soon as the conversation makes the inquiry clear. inquiry is that statement. reply must be an empty string, because the call continues to the next step without another spoken line.',
      '',
      'If you still cannot tell what they want, use clarify. Once it is clear, accept on this turn.',
    );
  }
  if (topics && topics.length > 0 && defaultTopicId) {
    lines.push(
      '',
      verify
        ? 'These are the topics a later step can route to. Use them to recognize the inquiry sooner. If the caller clearly matches one, confirm that inquiry now. Still do not answer it.'
        : 'These are the topics a later step can route to. Use the conversation and these topics to recognize the direction. If the caller clearly matches one, accept now and set topicId to it. If the inquiry is clear but nothing matches, accept with the default id. Still do not answer the inquiry.',
      '',
      'Topics:',
      ...topics.map((topic) => `- ${topic.id}: ${topic.description}`),
      `- ${defaultTopicId}: anything that does not match a topic above`,
      '',
      'Return topicId set to exactly one of those ids on every phase. Use the default id when none match.',
    );
  }
  lines.push('', topics && topics.length > 0 && defaultTopicId ? 'Return JSON with reply, inquiry, phase, and topicId.' : 'Return JSON with reply, inquiry, and phase.');
  if (note?.trim()) {
    lines.push('', `Note: ${note.trim()}`);
  }
  return lines.join('\n');
}

export function readInquiryTurn(value: unknown, allowedTopicIds?: string[], fallbackTopicId?: string): InquiryTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('OpenAI returned an unreadable reply.');
  }
  const record = value as { reply?: unknown; inquiry?: unknown; phase?: unknown; topicId?: unknown };
  if (typeof record.phase !== 'string' || !INQUIRY_PHASES.includes(record.phase as InquiryPhase)) {
    throw new BadRequestException('OpenAI returned an unknown phase.');
  }
  const phase = record.phase as InquiryPhase;
  if (typeof record.reply !== 'string') {
    throw new BadRequestException('OpenAI returned an unreadable reply.');
  }
  let reply = record.reply.trim().slice(0, 2000);
  const inquiry = readInquiry(record.inquiry);
  if ((phase === 'confirm' || phase === 'accepted') && !inquiry) {
    throw new BadRequestException('OpenAI did not name the inquiry.');
  }
  if (phase === 'clarify' && !reply) {
    throw new BadRequestException('OpenAI did not return a reply.');
  }
  if (phase === 'confirm' && inquiry && !reply) {
    reply = `So you want ${inquiry}?`;
  }
  if (phase === 'accepted' && !reply) {
    reply = 'Okay.';
  }
  let topicId: string | null = null;
  if (allowedTopicIds && allowedTopicIds.length > 0 && fallbackTopicId) {
    topicId = typeof record.topicId === 'string' && allowedTopicIds.includes(record.topicId) ? record.topicId : fallbackTopicId;
  }
  return { reply, inquiry, phase, topicId };
}

export function withoutVerification(turn: InquiryTurn): InquiryTurn {
  if (turn.phase === 'clarify' || !turn.inquiry) return turn;
  return { ...turn, phase: 'accepted', reply: '' };
}

function readInquiry(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException('OpenAI returned an unreadable inquiry.');
  }
  const trimmed = value.trim().slice(0, 500);
  return trimmed.length > 0 ? trimmed : null;
}
