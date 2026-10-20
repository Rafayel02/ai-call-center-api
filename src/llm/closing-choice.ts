export type ClosingOutcome = 'questions' | 'done';

export function closingPrompt(question: string, answer: string) {
  return [
    'You decide whether a phone caller is finished or still has questions.',
    `The agent asked: ${question}`,
    `The caller answered: ${answer}`,
    'outcome "questions": they still want help, have another question, say yes, or the answer does not clearly end the call.',
    'outcome "done": they are satisfied, say no, goodbye, that is all, or they have nothing else.',
    'Return JSON with outcome.',
  ].join('\n');
}

export function readClosingChoice(value: unknown): ClosingOutcome {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? (value as { outcome?: unknown }) : {};
  return record.outcome === 'done' ? 'done' : 'questions';
}
