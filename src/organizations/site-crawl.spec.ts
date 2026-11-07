import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { pageIdentity } from '../scenarios/site-pages';
import { crawlWebsite, type FetchedPage } from './site-crawl';

test('a local site exports each page once and continues after a failure', async () => {
  const pages: Record<string, string> = {
    '/': '<html><title>Home</title><main><h1>Home</h1><p>Welcome to the clinic hours and fees.</p><a href="/hours">Hours</a><a href="/hours/">dup</a><a href="/missing">Missing</a><a href="/private">Private</a><a href="/logo.png">Logo</a></main></html>',
    '/hours': '<html><title>Hours</title><main><h1>Hours</h1><p>The clinic is open on weekdays from nine to five.</p></main></html>',
    '/robots.txt': 'User-agent: *\nDisallow: /private\n',
    '/private': '<html><main><p>Secret staff notes that should never be exported from the site.</p></main></html>',
  };
  const server = await listen((request, response) => {
    const path = request.url ?? '/';
    if (path === '/missing') {
      response.writeHead(500, { 'content-type': 'text/html' });
      response.end('no');
      return;
    }
    const body = pages[path];
    if (!body) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
      return;
    }
    response.writeHead(200, { 'content-type': path.endsWith('.txt') ? 'text/plain' : 'text/html' });
    response.end(body);
  });
  try {
    const origin = address(server);
    const report = await crawlWebsite(`${origin}/`, { fetchPage: (url) => fetchLocal(url) });
    assert.deepEqual(report.exported.map((page) => page.title).sort(), ['Home', 'Hours']);
    assert.equal(new Set(report.exported.map((page) => page.url)).size, report.exported.length);
    assert.equal(report.exported.filter((page) => page.fileName === '127.0.0.1-hours.md').length, 1);
    assert.ok(report.failed.some((item) => item.url.endsWith('/missing')));
    assert.ok(report.skipped.some((item) => item.reason === 'Blocked by robots.txt.'));
    assert.equal(report.exported.some((page) => page.url.endsWith('/private')), false);
  } finally {
    await close(server);
  }
});

test('a second crawl skips pages that were already saved', async () => {
  const html = '<html><title>Home</title><main><h1>Home</h1><p>Welcome to the clinic hours and fees.</p></main></html>';
  const server = await listen((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(html);
  });
  try {
    const origin = address(server);
    const first = await crawlWebsite(`${origin}/`, { fetchPage: (url) => fetchLocal(url) });
    const known = new Set(first.exported.map((page) => page.url));
    const second = await crawlWebsite(`${origin}/`, { fetchPage: (url) => fetchLocal(url), known });
    assert.equal(second.exported.length, 0);
    assert.ok(second.skipped.some((item) => item.reason === 'Already saved.'));
  } finally {
    await close(server);
  }
});

test('a language address continues into that language when its first page was already saved', async () => {
  const pages: Record<string, string> = {
    '/en': page('English home', ['/en/plans', '/hy', '/ru']),
    '/en/plans': page('English plans with weekday prices and included minutes.', []),
    '/hy': page('Armenian home', ['/hy/cosmo', '/en']),
    '/hy/cosmo': page('Կոսմո includes television, home internet, and a mobile line.', []),
    '/ru': page('Russian home with tariffs and television packages.', []),
    '/robots.txt': 'User-agent: *\nAllow: /\n',
  };
  const server = await listen((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const body = pages[path];
    if (!body) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
      return;
    }
    response.writeHead(200, { 'content-type': path.endsWith('.txt') ? 'text/plain' : 'text/html' });
    response.end(body);
  });
  try {
    const origin = address(server);
    const fetchPage = (url: string) => fetchLocal(url);
    const english = await crawlWebsite(`${origin}/en`, { fetchPage });
    assert.deepEqual(english.exported.map((item) => new URL(item.url).pathname).sort(), ['/en', '/en/plans']);
    const known = new Set(english.exported.map((item) => item.url));
    known.add(pageIdentity(`${origin}/hy`)!);
    const armenian = await crawlWebsite(`${origin}/hy`, { fetchPage, known });
    assert.deepEqual(armenian.exported.map((item) => new URL(item.url).pathname), ['/hy/cosmo']);
    assert.ok(armenian.skipped.some((item) => item.reason === 'Already saved.'));
  } finally {
    await close(server);
  }
});

function page(text: string, links: string[]) {
  const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join('');
  return `<html><title>${text}</title><main><h1>${text}</h1><p>${text} Details for this page stay long enough to save.</p>${anchors}</main></html>`;
}

async function fetchLocal(url: string): Promise<FetchedPage> {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) throw new Error(`The page returned ${response.status}.`);
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('png')) return { url, kind: 'skip', body: '', reason: 'Skipped a file that is not a page.' };
  return { url, kind: type.includes('plain') ? 'text' : 'html', body };
}

function listen(handler: (request: { url?: string }, response: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }) => void) {
  const server = createServer((request, response) => handler(request, response));
  return new Promise<Server>((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function address(server: Server) {
  const info = server.address() as AddressInfo;
  return `http://127.0.0.1:${info.port}`;
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
