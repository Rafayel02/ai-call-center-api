import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BadRequestException } from '@nestjs/common';
import { extractText } from 'unpdf';
import { PAGE_TEXT_LIMIT, SITE_PAGE_LIMIT, cleanPageUrl, pageIdentity, pageLinks, pageName, robotsSitemaps, sameSite, sitemapLocs } from './site-pages';
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

export interface CrawledPage {
  url: string;
  name: string;
  text: string;
}

export async function textFromLink(raw: string) {
  const document = await fetchDocument(raw);
  return requireText(document.html ? pageText(document.body) : document.body);
}

/** Read the page that was pasted, then the same site's sitemap and linked HTML pages. */
export async function crawlSite(seedRaw: string): Promise<CrawledPage[]> {
  const first = await fetchDocument(seedRaw);
  const site = new URL(first.url);
  const pages: CrawledPage[] = [];
  const seen = new Set<string>();
  const keep = (url: string, body: string, html: boolean) => {
    const identity = pageIdentity(url);
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    const text = (html ? pageText(body) : body).replace(/\s+/g, ' ').trim().slice(0, PAGE_TEXT_LIMIT);
    if (text.length < 30) return;
    pages.push({ url, name: pageName(url), text });
  };
  keep(first.url, first.body, first.html);

  const queue: string[] = [];
  const enqueue = (urls: string[]) => {
    for (const url of urls) {
      const cleaned = cleanPageUrl(url, site);
      const identity = cleaned ? pageIdentity(cleaned) : null;
      if (!cleaned || !identity || seen.has(identity) || queue.includes(cleaned)) continue;
      queue.push(cleaned);
      if (pages.length + queue.length >= SITE_PAGE_LIMIT) return;
    }
  };
  const discovered = discoverPages(site);
  if (first.html) enqueue(pageLinks(first.body, site));
  enqueue(await discovered);

  const wave = queue.splice(0, SITE_PAGE_LIMIT - pages.length);
  const fetched = await mapPool(wave, 4, (url) => fetchDocument(url).catch(() => null));
  const deeper: string[] = [];
  for (const document of fetched) {
    if (!document) continue;
    keep(document.url, document.body, document.html);
    if (document.html) deeper.push(...pageLinks(document.body, new URL(document.url)));
  }
  if (pages.length < SITE_PAGE_LIMIT) {
    const more: string[] = [];
    for (const link of deeper) {
      const cleaned = cleanPageUrl(link, site);
      const identity = cleaned ? pageIdentity(cleaned) : null;
      if (!cleaned || !identity || seen.has(identity) || more.includes(cleaned)) continue;
      more.push(cleaned);
      if (pages.length + more.length >= SITE_PAGE_LIMIT) break;
    }
    const second = await mapPool(more, 4, (url) => fetchDocument(url).catch(() => null));
    for (const document of second) {
      if (!document) continue;
      keep(document.url, document.body, document.html);
    }
  }
  if (pages.length === 0) throw new BadRequestException('That source has no readable text.');
  return pages;
}

async function discoverPages(site: URL) {
  const seeds = [`${site.origin}/sitemap.xml`];
  const robots = await fetchDocument(`${site.origin}/robots.txt`).catch(() => null);
  if (robots) {
    for (const sitemap of robotsSitemaps(robots.body)) {
      try {
        if (sameSite(new URL(sitemap), site)) seeds.push(sitemap);
      } catch {
        continue;
      }
    }
  }
  const pages: string[] = [];
  const seen = new Set<string>();
  const queue = seeds.slice(0, 5);
  let indexes = 0;
  while (queue.length > 0 && pages.length < SITE_PAGE_LIMIT && indexes < 6) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const document = await fetchDocument(url).catch(() => null);
    if (!document) continue;
    indexes += 1;
    const parsed = sitemapLocs(document.body, site);
    for (const page of parsed.pages) {
      if (pages.length >= SITE_PAGE_LIMIT) break;
      pages.push(page);
    }
    for (const child of parsed.indexes) {
      if (queue.length < 8) queue.push(child);
    }
  }
  return pages;
}

async function fetchDocument(raw: string) {
  let current = await publicUrl(raw);
  for (let hop = 0; hop < 3; hop += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
        headers: { 'user-agent': 'ai-call-center', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
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
    if (type.includes('pdf') || bytes.subarray(0, 5).toString('utf8') === '%PDF-') {
      return { url: current.toString(), body: await pdfText(bytes), html: false };
    }
    const body = bytes.toString('utf8');
    const html = type.includes('html') || /<html|<body|<main|<a[\s>]/i.test(body.slice(0, 1500));
    return { url: current.toString(), body, html };
  }
  throw new BadRequestException('The link redirected too many times.');
}

async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
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
