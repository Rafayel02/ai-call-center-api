import { publicUrl } from '../scenarios/voice-sources';
import type { FetchedPage } from './site-crawl';

const PAGE_LIMIT = 1_500_000;

export async function fetchPublicPage(raw: string): Promise<FetchedPage> {
  let current = await publicUrl(raw);
  for (let hop = 0; hop < 3; hop += 1) {
    const response = await fetchWithRetry(current);
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      if (!next) return skip(current.toString(), 'The page did not return content.');
      current = await publicUrl(new URL(next, current).toString());
      continue;
    }
    if (!response.ok) return skip(current.toString(), `The page returned ${response.status}.`);
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (isBinary(type)) return skip(current.toString(), 'Skipped a file that is not a page.');
    const advertised = Number(response.headers.get('content-length') ?? 0);
    if (advertised > PAGE_LIMIT) return skip(current.toString(), 'The page is too large.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 5).toString('utf8') === '%PDF-') return skip(current.toString(), 'Skipped a file that is not a page.');
    if (bytes.length > PAGE_LIMIT) return skip(current.toString(), 'The page is too large.');
    const body = bytes.toString('utf8');
    const xml = type.includes('xml') || /<urlset[\s>]|<sitemapindex[\s>]/i.test(body.slice(0, 800));
    const html = type.includes('html') || /<html|<body|<main|<a[\s>]/i.test(body.slice(0, 1500));
    if (!html && !xml && type && !type.includes('text')) return skip(current.toString(), 'Skipped a file that is not a page.');
    return { url: current.toString(), kind: xml && !html ? 'xml' : html ? 'html' : 'text', body };
  }
  return skip(current.toString(), 'The page redirected too many times.');
}

function skip(url: string, reason: string): FetchedPage {
  return { url, kind: 'skip', body: '', reason };
}

function isBinary(type: string) {
  return /pdf|image|audio|video|octet-stream|zip|msword|officedocument/.test(type);
}

async function fetchWithRetry(url: URL) {
  let last: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(12_000),
        headers: { 'user-agent': 'ai-call-center', accept: 'text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.5' },
      });
      if (response.status !== 429 && response.status !== 503) return response;
      last = response;
      const retry = Number(response.headers.get('retry-after') ?? '');
      const wait = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 5) * 1000 : 400 * (attempt + 1);
      await delay(wait);
    } catch {
      if (attempt === 2) throw new Error('The page could not be read.');
      await delay(400 * (attempt + 1));
    }
  }
  if (!last) throw new Error('The page could not be read.');
  return last;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
