/** Pull spoken sentences out of a streaming inquiry JSON object. Reply is the first field. */
export class ReplyAssembler {
  private raw = '';
  private reply = '';
  private taken = 0;
  private closed = false;

  push(delta: string) {
    this.raw += delta;
    const field = readJsonString(this.raw, 'reply');
    if (!field) return [] as string[];
    this.reply = field.value;
    this.closed = field.closed;
    return this.pull();
  }

  private pull() {
    const pending = this.reply.slice(this.taken);
    const spoken: string[] = [];
    const boundary = /[.!?։](?=\s|$)/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(pending))) {
      const sentence = pending.slice(cursor, match.index + match[0].length).trim();
      if (sentence) spoken.push(sentence);
      cursor = match.index + match[0].length;
      const gap = /^\s+/.exec(pending.slice(cursor));
      if (gap) cursor += gap[0].length;
    }
    this.taken += cursor;
    if (this.closed) {
      const tail = this.reply.slice(this.taken).trim();
      if (tail) spoken.push(tail);
      this.taken = this.reply.length;
    }
    return spoken;
  }

  get replyClosed() {
    return this.closed;
  }
}

export function readJsonString(source: string, field: string): { value: string; closed: boolean } | null {
  const key = `"${field}"`;
  const at = source.indexOf(key);
  if (at < 0) return null;
  let index = at + key.length;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source[index] !== ':') return null;
  index += 1;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  if (source[index] !== '"') return null;
  index += 1;
  let value = '';
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      if (index + 1 >= source.length) return { value, closed: false };
      const next = source[index + 1];
      if (next === 'u') {
        if (index + 6 > source.length) return { value, closed: false };
        const hex = source.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value, closed: false };
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      const decoded: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/' };
      value += decoded[next] ?? next;
      index += 2;
      continue;
    }
    if (char === '"') return { value, closed: true };
    value += char;
    index += 1;
  }
  return { value, closed: false };
}
