import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanPageUrl, pageIdentity, pageLinks, robotsSitemaps, sitemapLocs } from './site-pages';

test('a site keeps its own pages and drops files, menus targets, and other hosts', () => {
  const base = new URL('https://www.example.com/start');
  const links = pageLinks(
    '<a href="/plans">Plans</a><a href="https://example.com/plans/">dup</a><a href="https://other.test/x">no</a><a href="/logo.png">img</a><a href="mailto:a@b.c">m</a><a href="/login">in</a>',
    base,
  );
  assert.deepEqual(links, ['https://www.example.com/plans']);
  assert.equal(pageIdentity(links[0]), pageIdentity('https://example.com/plans/'));
  assert.equal(cleanPageUrl('https://evil.test/hours', base), null);
});

test('a sitemap lists pages and nested sitemap files', () => {
  const site = new URL('https://www.example.com/');
  const index = sitemapLocs('<sitemapindex><sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap></sitemapindex>', site);
  assert.deepEqual(index.indexes, ['https://example.com/sitemap-pages.xml']);
  const pages = sitemapLocs('<urlset><url><loc>https://example.com/hours/</loc></url><url><loc>https://evil.test/x</loc></url></urlset>', site);
  assert.deepEqual(pages.pages, ['https://example.com/hours']);
  assert.deepEqual(robotsSitemaps('User-agent: *\nSitemap: https://example.com/sitemap.xml\n'), ['https://example.com/sitemap.xml']);
});
