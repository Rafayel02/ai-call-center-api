import { cleanPageUrl, pageIdentity, pageLinks, robotsSitemaps, sameSite, sitemapLocs } from '../scenarios/site-pages';
import { htmlToMarkdown, pageFileName, robotsAllows } from './site-export';

export const SITE_PAGE_CAP = 40;

export interface FetchedPage {
  url: string;
  kind: 'html' | 'text' | 'xml' | 'skip';
  body: string;
  reason?: string;
}

export interface ExportedPage {
  url: string;
  finalUrl: string;
  title: string;
  fileName: string;
  markdown: string;
}

export interface CrawlReport {
  discovered: number;
  exported: ExportedPage[];
  skipped: Array<{ url: string; reason: string }>;
  failed: Array<{ url: string; message: string }>;
}

export async function crawlWebsite(
  start: string,
  options: {
    fetchPage: (url: string) => Promise<FetchedPage>;
    maxPages?: number;
    known?: Set<string>;
    onPage?: (page: ExportedPage) => Promise<'saved' | 'duplicate' | void>;
  },
): Promise<CrawlReport> {
  const maxPages = Math.min(Math.max(options.maxPages ?? SITE_PAGE_CAP, 1), SITE_PAGE_CAP);
  const site = new URL(start);
  const known = options.known ?? new Set<string>();
  const seen = new Set<string>();
  const names = new Set<string>();
  const queue: string[] = [];
  const report: CrawlReport = { discovered: 0, exported: [], skipped: [], failed: [] };

  let robotsText = '';
  const enqueue = (urls: string[], enforceRobots: boolean) => {
    for (const url of urls) {
      const cleaned = cleanPageUrl(url, site);
      const identity = cleaned ? pageIdentity(cleaned) : null;
      if (!cleaned || !identity || seen.has(identity) || queue.includes(cleaned)) continue;
      if (enforceRobots) {
        try {
          if (!robotsAllows(robotsText, new URL(cleaned).pathname)) {
            report.skipped.push({ url: cleaned, reason: 'Blocked by robots.txt.' });
            seen.add(identity);
            continue;
          }
        } catch {
          continue;
        }
      }
      if (report.exported.length + queue.length >= maxPages) return;
      queue.push(cleaned);
    }
  };

  enqueue([start], false);
  const discovery = await sitemapPages(site, options.fetchPage);
  robotsText = discovery.robots;
  enqueue(discovery.pages, true);

  while (queue.length > 0 && report.exported.length < maxPages) {
    const batch = queue.splice(0, 3);
    const found: string[] = [];
    await Promise.all(
      batch.map(async (url) => {
        const identity = pageIdentity(url);
        if (!identity || seen.has(identity)) return;
        seen.add(identity);
        report.discovered += 1;
        if (known.has(identity)) {
          report.skipped.push({ url, reason: 'Already saved.' });
          return;
        }
        let page: FetchedPage;
        try {
          page = await options.fetchPage(url);
        } catch (error) {
          report.failed.push({ url, message: error instanceof Error && error.message ? error.message : 'The page could not be read.' });
          return;
        }
        if (page.kind === 'skip') {
          report.skipped.push({ url: page.url || url, reason: page.reason || 'Skipped.' });
          return;
        }
        if (page.kind === 'xml') return;
        const readable = page.kind === 'html' ? htmlToMarkdown(page.body, page.url) : { title: page.url, markdown: page.body.replace(/\s+/g, ' ').trim() };
        if (readable.markdown.length < 40) {
          report.skipped.push({ url: page.url, reason: 'The page has no readable text.' });
          return;
        }
        if (report.exported.length >= maxPages) return;
        const exported: ExportedPage = {
          url: identity,
          finalUrl: page.url,
          title: readable.title,
          fileName: pageFileName(identity, names),
          markdown: readable.markdown.slice(0, 60_000),
        };
        try {
          if ((await options.onPage?.(exported)) === 'duplicate') {
            report.skipped.push({ url: page.url, reason: 'Already saved.' });
            return;
          }
        } catch (error) {
          report.failed.push({ url: page.url, message: error instanceof Error && error.message ? error.message : 'The page could not be saved.' });
          return;
        }
        report.exported.push(exported);
        if (page.kind === 'html') found.push(...pageLinks(page.body, new URL(page.url)));
      }),
    );
    enqueue(found, true);
  }
  return report;
}

async function sitemapPages(site: URL, fetchPage: (url: string) => Promise<FetchedPage>): Promise<{ pages: string[]; robots: string }> {
  const seeds = [`${site.origin}/sitemap.xml`];
  const robots = await fetchPage(`${site.origin}/robots.txt`).catch(() => null);
  if (robots?.kind === 'text' || robots?.kind === 'xml') {
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
  while (queue.length > 0 && pages.length < SITE_PAGE_CAP && seen.size < 6) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const document = await fetchPage(url).catch(() => null);
    if (!document || (document.kind !== 'xml' && document.kind !== 'text')) continue;
    const parsed = sitemapLocs(document.body, site);
    pages.push(...parsed.pages);
    for (const child of parsed.indexes) {
      if (queue.length < 8) queue.push(child);
    }
  }
  return { pages, robots: robots?.body ?? '' };
}
