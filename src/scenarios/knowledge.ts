export interface KnowledgeRow {
  sourceName: string;
  text: string;
  vector: Float32Array;
}

/** Cover the whole page. Overlap keeps a fact that sits on a boundary in both passages. */
export function chunkText(text: string, size = 1_400, overlap = 200) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length && chunks.length < 80) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const breakAt = clean.lastIndexOf(' ', end);
      if (breakAt > start + size / 2) end = breakAt;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    const next = end - overlap;
    start = next > start ? next : end;
  }
  return chunks;
}

export function encodeVector(values: number[]) {
  const buffer = Buffer.alloc(values.length * 4);
  for (let index = 0; index < values.length; index += 1) buffer.writeFloatLE(values[index], index * 4);
  return buffer;
}

export function decodeVector(bytes: Buffer) {
  const values = new Float32Array(Math.floor(bytes.length / 4));
  for (let index = 0; index < values.length; index += 1) values[index] = bytes.readFloatLE(index * 4);
  return values;
}

export function searchPassages(query: Float32Array, rows: KnowledgeRow[], limit = 8) {
  const ranked = rows
    .map((row) => ({ row, score: cosine(query, row.vector) }))
    .filter((item) => item.score >= 0.22)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  if (ranked.length === 0) return 'No passage matches this question.';
  return ranked.map((item) => `${item.row.sourceName}\n${item.row.text}`).join('\n\n');
}

export function knowledgeGuide(names: string[]) {
  const documents = [...new Set(names.map((name) => name.trim()).filter(Boolean))].slice(0, 40).join(', ');
  return [
    'The documents for this line are searched for every question.',
    'Answer only from the passages given with that question.',
    'If no passage covers it, say you do not have that information.',
    'Do not invent prices, plans, addresses, hours, or policies.',
    documents ? `Documents: ${documents}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function cosine(left: Float32Array, right: Float32Array) {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}
