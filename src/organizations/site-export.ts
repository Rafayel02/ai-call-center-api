import { createHash } from 'node:crypto';
import { pageIdentity } from '../scenarios/site-pages';

const CHROME = /<(script|style|noscript|svg|nav|footer|header|aside|form|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COOKIE = /<(div|section)\b[^>]*(?:cookie|consent|banner|newsletter)[^>]*>[\s\S]*?<\/\1>/gi;

export function robotsAllows(text: string, pathname: string) {
  const lines = text.split(/\r?\n/);
  let applies = false;
  let allowed = true;
  let best = -1;
  for (const line of lines) {
    const trimmed = line.split('#')[0]?.trim() ?? '';
    const agent = trimmed.match(/^user-agent:\s*(.*)$/i);
    if (agent) {
      applies = agent[1].trim() === '*';
      continue;
    }
    if (!applies) continue;
    const rule = trimmed.match(/^(allow|disallow):\s*(.*)$/i);
    if (!rule) continue;
    const path = rule[2].trim();
    if (!path) {
      if (rule[1].toLowerCase() === 'disallow' && best < 0) allowed = true;
      continue;
    }
    if (pathname.startsWith(path) && path.length > best) {
      best = path.length;
      allowed = rule[1].toLowerCase() === 'allow';
    }
  }
  return allowed;
}

export function htmlToMarkdown(html: string, pageUrl: string) {
  const title = textContent(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || textContent(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '') || pageUrl;
  const region = html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  let body = region.replace(CHROME, ' ').replace(COOKIE, ' ');
  body = body.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, code: string) => `\n\n\`\`\`\n${decode(code).trim()}\n\`\`\`\n\n`);
  body = body.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\n\`\`\`\n${textContent(code)}\n\`\`\`\n\n`);
  body = convertTables(body);
  body = body.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${textContent(inner)}\n\n`);
  body = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `\n- ${textContent(inner)}`);
  body = body.replace(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_, left: string, right: string, inner: string) => link(left ?? right ?? '', textContent(inner), pageUrl));
  body = body.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n');
  body = decode(body.replace(/<[^>]+>/g, ' '));
  const markdown = body
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { title: title.replace(/\s+/g, ' ').trim().slice(0, 300), markdown };
}

export function pageFileName(raw: string, taken: Set<string>) {
  const identity = pageIdentity(raw) ?? raw;
  let url: URL;
  try {
    url = new URL(identity);
  } catch {
    url = new URL('https://page.invalid/');
  }
  const path = url.pathname === '/' ? 'index' : url.pathname.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '-');
  const query = url.search ? `-${url.search.slice(1)}` : '';
  const base = `${url.hostname}-${path}${query}`
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'page';
  let name = `${base}.md`;
  if (taken.has(name)) {
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 8);
    name = `${base.slice(0, 100)}-${hash}.md`;
  }
  taken.add(name);
  return name;
}

export function withFrontMatter(input: { title: string; source: string; finalUrl: string; markdown: string; fetchedAt: string }) {
  const hash = createHash('sha256').update(input.markdown).digest('hex').slice(0, 16);
  return {
    hash,
    text: [
      '---',
      `title: ${yaml(input.title)}`,
      `source: ${yaml(input.source)}`,
      `final: ${yaml(input.finalUrl)}`,
      `fetched: ${yaml(input.fetchedAt)}`,
      `hash: ${yaml(hash)}`,
      '---',
      '',
      input.markdown,
      '',
    ].join('\n'),
  };
}

function convertTables(html: string) {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, inner: string) => {
    const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => textContent(cell[1]).replace(/\|/g, '\\|')),
    );
    const filled = rows.filter((row) => row.some(Boolean));
    if (filled.length === 0) return '';
    const width = Math.max(...filled.map((row) => row.length));
    const normalized = filled.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill('')]);
    const header = normalized[0] ?? [];
    return `\n\n| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n${normalized
      .slice(1)
      .map((row) => `| ${row.join(' | ')} |`)
      .join('\n')}\n\n`;
  });
}

function link(href: string, label: string, pageUrl: string) {
  const text = label.trim();
  if (!href || href.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(href)) return text;
  try {
    return `[${text || href}](${new URL(href, pageUrl).toString()})`;
  } catch {
    return text;
  }
}

function textContent(value: string) {
  return decode(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decode(value: string) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => {
      const parsed = Number(code);
      return parsed > 0 && parsed < 0x110000 ? String.fromCodePoint(parsed) : ' ';
    });
}

function yaml(value: string) {
  return JSON.stringify(value.replace(/\s+/g, ' ').trim());
}
