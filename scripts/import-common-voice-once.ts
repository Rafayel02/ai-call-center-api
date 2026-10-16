/**
 * One-time import of 50 Armenian Common Voice 20 clips into the dataset.
 *
 * This does not run on deploy or server startup. If those clips are already
 * stored, the script stops without downloading anything.
 *
 * IMPORT_EMAIL=you@example.com IMPORT_PASSWORD=... npx tsx scripts/import-common-voice-once.ts
 */
const API_URL = (process.env.API_URL ?? 'https://api-production-14d9.up.railway.app').replace(/\/$/, '');
const ORIGIN = process.env.IMPORT_ORIGIN ?? 'https://ai-call-center-web.vercel.app';
const SOURCE = 'common_voice_20_armenian';
const DATASET = 'Chillarmo/common_voice_20_armenian';
const SPLIT = 'train';
const COUNT = 50;

interface CommonVoiceRow {
  sentence?: string;
  age?: string;
  gender?: string;
  locale?: string;
  sentence_id?: string;
  path?: string;
  audio?: { src?: string; type?: string }[];
}

interface StoredSample {
  source: string | null;
  externalId: string | null;
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running this import.`);
  return value;
}

function cookieHeader(response: Response) {
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const header = cookies.map((cookie) => cookie.split(';')[0]).join('; ');
  if (!header) throw new Error('Login did not return a session cookie.');
  return header;
}

async function api(path: string, cookie: string, init: RequestInit = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Origin: ORIGIN,
      Cookie: cookie,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as { message?: string | string[] }) : {};
  if (!response.ok) {
    const message = Array.isArray(data.message) ? data.message.join(' ') : data.message;
    throw new Error(message || `Request failed with status ${response.status}.`);
  }
  return data;
}

async function main() {
  const email = requiredEnv('IMPORT_EMAIL');
  const password = requiredEnv('IMPORT_PASSWORD');
  const login = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`Login failed with status ${login.status}.`);
  const cookie = cookieHeader(login);

  const existing = (await api('/dataset-samples', cookie)) as StoredSample[];
  const imported = existing.filter((sample) => sample.source === SOURCE);
  if (imported.length > 0) {
    console.log(`Already imported ${imported.length} Common Voice samples. Not running again.`);
    return;
  }

  const rowsUrl = new URL('https://datasets-server.huggingface.co/rows');
  rowsUrl.searchParams.set('dataset', DATASET);
  rowsUrl.searchParams.set('config', 'default');
  rowsUrl.searchParams.set('split', SPLIT);
  rowsUrl.searchParams.set('offset', '0');
  rowsUrl.searchParams.set('length', String(COUNT));
  const listed = await fetch(rowsUrl);
  if (!listed.ok) throw new Error(`Could not read Common Voice rows (${listed.status}).`);
  const payload = (await listed.json()) as { rows?: { row: CommonVoiceRow }[] };
  const rows = payload.rows ?? [];
  if (rows.length !== COUNT) throw new Error(`Expected ${COUNT} rows and received ${rows.length}.`);

  for (const [index, entry] of rows.entries()) {
    const row = entry.row;
    const sentence = row.sentence?.trim();
    const externalId = row.sentence_id?.trim();
    const audioUrl = row.audio?.[0]?.src;
    const filename = (row.path || `sample-${index + 1}.mp3`).replace(/[^\w.\-]+/g, '_');
    if (!sentence || !externalId || !audioUrl) throw new Error(`Row ${index + 1} is missing sentence, id, or audio.`);

    const audio = await fetch(audioUrl);
    if (!audio.ok) throw new Error(`Could not download ${filename} (${audio.status}).`);
    const bytes = Buffer.from(await audio.arrayBuffer());
    const form = new FormData();
    form.set('sentence', sentence);
    if (row.age) form.set('age', row.age);
    if (row.gender) form.set('gender', row.gender);
    if (row.locale) form.set('locale', row.locale);
    form.set('source', SOURCE);
    form.set('externalId', externalId);
    form.set('audio', new Blob([bytes], { type: row.audio?.[0]?.type || 'audio/mpeg' }), filename);

    await api('/dataset-samples', cookie, { method: 'POST', body: form });
    console.log(`Saved ${index + 1}/${COUNT}`);
  }

  console.log(`Imported ${COUNT} samples from ${DATASET} (${SPLIT}).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Import failed.');
  process.exit(1);
});
