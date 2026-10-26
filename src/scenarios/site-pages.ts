export const SITE_PAGE_LIMIT = 30;
export const PAGE_TEXT_LIMIT = 40_000;
export const THIN_SITE_PAGES = 8;

const ASSET = /\.(png|jpe?g|gif|webp|svg|ico|css|js|mjs|map|pdf|zip|gz|rar|mp3|mp4|webm|woff2?|ttf|eot|xml|json|rss|atom)$/i;
const SKIP = /^\/(wp-admin|wp-json|wp-login\.php|wp-content|wp-includes|xmlrpc\.php|cdn-cgi|cart|checkout|login|signin|sign-in|account|feed|search|tag|author)(\/|$)/i;
const TRACKING = /^(utm_|fbclid$|gclid$|mc_|_ga$)/i;
const HREF = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

export function sameSite(left: URL, right: URL) {
  return hostOf(left) === hostOf(right);
}

export function siteHost(raw: string) {
  try {
    return hostOf(new URL(raw));
  } catch {
    return '';
  }
}

export function pageIdentity(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  url.hash = '';
  url.hostname = hostOf(url);
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  url.search = searchWithoutTracking(url);
  return url.toString();
}

/** A same-site HTML page, with the host left as written so it can be fetched. */
export function cleanPageUrl(raw: string, site: URL) {
  let url: URL;
  try {
    url = new URL(raw, site);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  if (!sameSite(site, url) || !isContentPath(url.pathname)) return null;
  url.hash = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  url.search = searchWithoutTracking(url);
  return url.toString();
}

export function pageLinks(html: string, base: URL) {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(HREF)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!raw || raw.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(raw)) continue;
    const cleaned = cleanPageUrl(raw, base);
    const identity = cleaned ? pageIdentity(cleaned) : null;
    if (!cleaned || !identity || seen.has(identity)) continue;
    seen.add(identity);
    links.push(cleaned);
    if (links.length >= 80) break;
  }
  return links;
}

export function sitemapLocs(xml: string, site: URL) {
  const pages: string[] = [];
  const indexes: string[] = [];
  const seen = new Set<string>();
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  for (const match of xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
    const loc = decodeXml(match[1].trim());
    let url: URL;
    try {
      url = new URL(loc);
    } catch {
      continue;
    }
    if (!sameSite(site, url)) continue;
    if (isIndex || /\.xml$/i.test(url.pathname)) {
      indexes.push(url.toString());
      continue;
    }
    const cleaned = cleanPageUrl(url.toString(), site);
    const identity = cleaned ? pageIdentity(cleaned) : null;
    if (!cleaned || !identity || seen.has(identity)) continue;
    seen.add(identity);
    pages.push(cleaned);
  }
  return { pages, indexes };
}

export function robotsSitemaps(text: string) {
  return [...text.matchAll(/^Sitemap:\s*(\S+)/gim)].map((match) => match[1].trim()).slice(0, 5);
}

export function pageName(raw: string) {
  try {
    const url = new URL(raw);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.hostname}${path}`.slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}

function hostOf(url: URL) {
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

function isContentPath(pathname: string) {
  return !ASSET.test(pathname) && !SKIP.test(pathname);
}

function searchWithoutTracking(url: URL) {
  const params = new URLSearchParams(url.search);
  for (const key of [...params.keys()]) {
    if (TRACKING.test(key)) params.delete(key);
  }
  const search = params.toString();
  return search ? `?${search}` : '';
}

function decodeXml(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
