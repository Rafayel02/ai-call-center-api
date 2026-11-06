import { readIndexState, type IndexState } from './organization-resources';

export class OpenAiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function uploadOpenAiFile(apiKey: string, name: string, bytes: Buffer) {
  const form = new FormData();
  form.append('purpose', 'assistants');
  form.append('file', new Blob([new Uint8Array(bytes)]), name);
  const payload = await openAiRequest(apiKey, '/files', { method: 'POST', body: form });
  if (typeof payload.id !== 'string' || !payload.id) throw new OpenAiRequestError('OpenAI did not accept the file.', 502);
  return payload.id;
}

export async function createOpenAiVectorStore(apiKey: string, name: string) {
  const payload = await openAiRequest(apiKey, '/vector_stores', {
    method: 'POST',
    body: JSON.stringify({ name: name.slice(0, 200) }),
  });
  if (typeof payload.id !== 'string' || !payload.id) throw new OpenAiRequestError('OpenAI did not open a file index.', 502);
  return payload.id;
}

export function attachOpenAiFile(apiKey: string, vectorStoreId: string, fileId: string) {
  return openAiRequest(apiKey, `/vector_stores/${encodeURIComponent(vectorStoreId)}/files`, {
    method: 'POST',
    body: JSON.stringify({ file_id: fileId }),
  });
}

export async function readOpenAiFile(apiKey: string, vectorStoreId: string, fileId: string): Promise<IndexState> {
  const payload = await openAiRequest(
    apiKey,
    `/vector_stores/${encodeURIComponent(vectorStoreId)}/files/${encodeURIComponent(fileId)}`,
  );
  return readIndexState(payload);
}

export async function deleteOpenAiFile(apiKey: string, vectorStoreId: string, fileId: string) {
  await openAiRequest(apiKey, `/vector_stores/${encodeURIComponent(vectorStoreId)}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
  }).catch((error: unknown) => {
    if (error instanceof OpenAiRequestError && error.status === 404) return null;
    throw error;
  });
  await openAiRequest(apiKey, `/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }).catch((error: unknown) => {
    if (error instanceof OpenAiRequestError && error.status === 404) return null;
    throw error;
  });
}

export async function searchOpenAiVectorStore(apiKey: string, vectorStoreId: string, query: string, fileIds: string[]) {
  const body = { query, max_num_results: 12, rewrite_query: true };
  try {
    const filtered = await openAiRequest(apiKey, `/vector_stores/${encodeURIComponent(vectorStoreId)}/search`, {
      method: 'POST',
      body: JSON.stringify({ ...body, filters: { type: 'in', key: 'file_id', value: fileIds } }),
    });
    const hits = readSearchHits(filtered);
    const matched = hits.filter((hit) => fileIds.includes(hit.fileId));
    if (matched.length > 0) return matched;
    if (hits.length > 0 && hits.every((hit) => !hit.fileId)) return hits;
  } catch (error) {
    if (!(error instanceof OpenAiRequestError) || error.status < 400 || error.status >= 500) throw error;
  }
  const open = await openAiRequest(apiKey, `/vector_stores/${encodeURIComponent(vectorStoreId)}/search`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return readSearchHits(open).filter((hit) => fileIds.includes(hit.fileId));
}

export function readSearchHits(payload: unknown) {
  const data = payload && typeof payload === 'object' && 'data' in payload ? (payload as { data?: unknown }).data : [];
  if (!Array.isArray(data)) return [];
  const hits: Array<{ fileId: string; filename: string; text: string }> = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { file_id?: unknown; filename?: unknown; content?: unknown };
    const fileId = typeof row.file_id === 'string' ? row.file_id : '';
    const filename = typeof row.filename === 'string' && row.filename.trim() ? row.filename.trim() : 'file';
    const parts = Array.isArray(row.content) ? row.content : [];
    const text = parts
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) hits.push({ fileId, filename, text: text.slice(0, 1800) });
  }
  return hits.slice(0, 8);
}

export function formatSearchHits(hits: Array<{ filename: string; text: string }>) {
  if (hits.length === 0) return '';
  return hits.map((hit) => `[${hit.filename}]\n${hit.text}`).join('\n\n').slice(0, 6000);
}

export async function deleteOpenAiVectorStore(apiKey: string, vectorStoreId: string) {
  await openAiRequest(apiKey, `/vector_stores/${encodeURIComponent(vectorStoreId)}`, { method: 'DELETE' }).catch((error: unknown) => {
    if (error instanceof OpenAiRequestError && error.status === 404) return null;
    throw error;
  });
}

async function openAiRequest(apiKey: string, path: string, init: { method?: string; body?: FormData | string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`https://api.openai.com/v1${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
    });
  } catch {
    throw new OpenAiRequestError('OpenAI could not be reached.', 0);
  }
  const text = await response.text();
  let payload: { id?: unknown; error?: { message?: unknown } } = {};
  try {
    payload = text ? (JSON.parse(text) as typeof payload) : {};
  } catch {
    throw new OpenAiRequestError('OpenAI returned an unreadable response.', response.status);
  }
  if (!response.ok) {
    const message = typeof payload.error?.message === 'string' && payload.error.message.trim() ? payload.error.message.trim() : 'OpenAI could not index the file.';
    throw new OpenAiRequestError(message, response.status);
  }
  return payload as Record<string, unknown>;
}
