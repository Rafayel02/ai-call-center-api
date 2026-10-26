import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BadRequestException } from '@nestjs/common';
import { extractText } from 'unpdf';
import { pageText } from './voice-context';

const FILE_LIMIT = 1_000_000;
const PAGE_LIMIT = 1_500_000;

export function isPrivateAddress(address: string) {
  const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
  const lower = mapped.toLowerCase();
  if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  const parts = mapped.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export async function publicUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BadRequestException('Enter a full http or https link.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadRequestException('Enter a full http or https link.');
  if (url.username || url.password) throw new BadRequestException('That link is not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new BadRequestException('That link is not allowed.');
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BadRequestException('That link is not allowed.');
    return url;
  }
  const records = await lookup(host, { all: true }).catch(() => []);
  if (records.length === 0 || records.some((record) => isPrivateAddress(record.address))) {
    throw new BadRequestException('That link is not allowed.');
  }
  return url;
}

export async function textFromUpload(name: string, bytes: Buffer) {
  if (bytes.length === 0 || bytes.length > FILE_LIMIT) throw new BadRequestException('This file is empty or too large.');
  const lower = name.toLowerCase();
  const text = lower.endsWith('.pdf') || bytes.subarray(0, 5).toString('utf8') === '%PDF-' ? await pdfText(bytes) : documentText(name, bytes);
  return requireText(text);
}

export async function textFromLink(raw: string) {
  let current = await publicUrl(raw);
  for (let hop = 0; hop < 3; hop += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: { 'user-agent': 'ai-call-center' },
      });
    } catch {
      throw new BadRequestException('The link could not be read.');
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      if (!next) throw new BadRequestException('The link did not return a page.');
      current = await publicUrl(new URL(next, current).toString());
      continue;
    }
    if (!response.ok) throw new BadRequestException('The link could not be read.');
    const advertised = Number(response.headers.get('content-length') ?? 0);
    if (advertised > PAGE_LIMIT) throw new BadRequestException('That page is too large.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > PAGE_LIMIT) throw new BadRequestException('That page is too large.');
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (type.includes('pdf') || bytes.subarray(0, 5).toString('utf8') === '%PDF-') return requireText(await pdfText(bytes));
    const rawText = bytes.toString('utf8');
    return requireText(type.includes('html') || /<html|<body|<p[\s>]/i.test(rawText.slice(0, 800)) ? pageText(rawText) : rawText);
  }
  throw new BadRequestException('The link redirected too many times.');
}

function documentText(name: string, bytes: Buffer) {
  if (bytes.includes(0)) throw new BadRequestException('Upload a text file or a PDF.');
  const raw = bytes.toString('utf8');
  const lower = name.toLowerCase();
  if (lower.endsWith('.html') || lower.endsWith('.htm') || /<html|<body|<p[\s>]/i.test(raw.slice(0, 800))) return pageText(raw);
  return raw;
}

async function pdfText(bytes: Buffer) {
  try {
    const extracted = await extractText(new Uint8Array(bytes), { mergePages: true });
    return extracted.text;
  } catch {
    throw new BadRequestException('This PDF has no readable text.');
  }
}

function requireText(value: string) {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw new BadRequestException('That source has no readable text.');
  return text;
}
