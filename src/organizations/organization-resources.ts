import { BadRequestException } from '@nestjs/common';

const RESOURCE_EXTENSIONS = new Set(['pdf', 'txt', 'md', 'doc', 'docx', 'pptx', 'html', 'json']);
const FILE_LIMIT = 1_000_000;

export type IndexState = { status: 'INDEXING' | 'READY' | 'FAILED'; errorMessage: string | null };

export function resourceFileName(raw: string) {
  const base = raw.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  const clean = base.replace(/[^\w.\- ()]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const extension = clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!RESOURCE_EXTENSIONS.has(extension)) {
    throw new BadRequestException('Upload a PDF, Word, PowerPoint, text, markdown, HTML, or JSON file.');
  }
  return clean;
}

export function decodeResource(data: string) {
  const packed = data.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(packed)) throw new BadRequestException('This file could not be read.');
  const bytes = Buffer.from(packed, 'base64');
  if (bytes.length === 0 || bytes.length > FILE_LIMIT) throw new BadRequestException('This file is empty or larger than 1 MB.');
  return bytes;
}

export function readIndexState(payload: unknown): IndexState {
  const record = payload && typeof payload === 'object' ? (payload as { status?: unknown; last_error?: { message?: unknown } | null }) : {};
  const message = typeof record.last_error?.message === 'string' && record.last_error.message.trim() ? record.last_error.message.trim() : null;
  if (record.status === 'completed') return { status: 'READY', errorMessage: null };
  if (record.status === 'failed' || record.status === 'cancelled') {
    return { status: 'FAILED', errorMessage: message ?? 'OpenAI could not index this file.' };
  }
  return { status: 'INDEXING', errorMessage: null };
}
