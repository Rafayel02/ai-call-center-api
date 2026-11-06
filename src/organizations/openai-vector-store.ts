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
  return payload;
}
