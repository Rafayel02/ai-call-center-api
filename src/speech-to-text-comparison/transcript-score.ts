// Armenian emphasis, exclamation, and question marks sit inside a word, so they are dropped without splitting it.
const IN_WORD_MARKS = /[՛՜՞]/g;
const SEPARATORS = /[\p{P}\p{S}]+/gu;

export function transcriptWords(text: string) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(IN_WORD_MARKS, '')
    .replace(SEPARATORS, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function editDistance(expected: string[], heard: string[]) {
  let previous = Array.from({ length: heard.length + 1 }, (_, index) => index);
  for (let row = 1; row <= expected.length; row++) {
    const current = [row];
    for (let column = 1; column <= heard.length; column++) {
      const substitution = previous[column - 1] + (expected[row - 1] === heard[column - 1] ? 0 : 1);
      current[column] = Math.min(substitution, previous[column] + 1, current[column - 1] + 1);
    }
    previous = current;
  }
  return previous[heard.length];
}

/** Word accuracy, 1 − WER, clamped to 0..1. */
export function scoreTranscript(reference: string, transcript: string) {
  const expected = transcriptWords(reference);
  const heard = transcriptWords(transcript);
  if (expected.length === 0) return heard.length === 0 ? 1 : 0;
  return Math.max(0, 1 - editDistance(expected, heard) / expected.length);
}
