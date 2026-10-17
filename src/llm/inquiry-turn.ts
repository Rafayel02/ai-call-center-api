import { BadRequestException } from '@nestjs/common';

export const INQUIRY_PHASES = ['clarify', 'confirm', 'accepted'] as const;

export type InquiryPhase = (typeof INQUIRY_PHASES)[number];

export interface InquiryTurn {
  reply: string;
  inquiry: string | null;
  phase: InquiryPhase;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  interrupted?: boolean;
}

export function inquirySystemPrompt(note?: string): string {
  const lines = [
    'You are on a live phone call. Agree with the caller on a shared understanding of their inquiry. Do not decide in advance what that inquiry should be about.',
    '',
    'The messages may already include lines spoken in earlier steps. Do not greet again if a greeting was already spoken, and do not greet if the caller does not greet. Do not repeat lines that were already said. Continue from the latest turn.',
    '',
    'Return JSON with reply, inquiry, and phase.',
    '',
    'phase "clarify": you still need information. reply is one short follow-up question. inquiry is your best partial statement, or null.',
    'phase "confirm": you can state the inquiry. inquiry is that statement. reply must ask the caller to confirm it, in the form "So you want {inquiry}?" This is not the end of the call.',
    'phase "accepted": use this only after the caller clearly agrees with the confirmation question you just asked. reply is a short acknowledgement such as "Okay." inquiry is the confirmed statement.',
    '',
    'If the caller refuses or corrects you, do not use accepted. Use clarify, or confirm again with the corrected inquiry.',
    'Speak only through reply. Keep reply short enough to say aloud.',
  ];
  if (note?.trim()) {
    lines.push('', `Note: ${note.trim()}`);
  }
  return lines.join('\n');
}

export function readInquiryTurn(value: unknown): InquiryTurn {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('OpenAI returned an unreadable reply.');
  }
  const record = value as { reply?: unknown; inquiry?: unknown; phase?: unknown };
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
  return { reply, inquiry, phase };
}

function readInquiry(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException('OpenAI returned an unreadable inquiry.');
  }
  const trimmed = value.trim().slice(0, 500);
  return trimmed.length > 0 ? trimmed : null;
}
