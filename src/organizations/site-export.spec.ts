import assert from 'node:assert/strict';
import test from 'node:test';
import { htmlToMarkdown, pageFileName, robotsAllows, withFrontMatter } from './site-export';

test('markdown keeps the page and drops the chrome', () => {
  const page = htmlToMarkdown(
    `<html><title>Hours</title><nav>Menu</nav><main><h1>Hours</h1><ul><li>Weekdays</li></ul><p>See <a href="/fees">fees</a>.</p><table><tr><th>Day</th><th>Open</th></tr><tr><td>Mon</td><td>9</td></tr></table><pre><code>9-5</code></pre></main><footer>Footer</footer><div class="cookie-banner">Accept cookies</div></html>`,
    'https://example.com/hours',
  );
  assert.equal(page.title, 'Hours');
  assert.match(page.markdown, /# Hours/);
  assert.match(page.markdown, /- Weekdays/);
  assert.match(page.markdown, /\[fees\]\(https:\/\/example\.com\/fees\)/);
  assert.match(page.markdown, /\| Day \| Open \|/);
  assert.match(page.markdown, /```\n9-5\n```/);
  assert.doesNotMatch(page.markdown, /Menu|Footer|Accept cookies/);
});

test('filenames stay readable and do not collide', () => {
  const taken = new Set<string>();
  const first = pageFileName('https://www.example.com/hours/', taken);
  const second = pageFileName('https://example.com/hours?plan=evening', taken);
  assert.equal(first, 'example.com-hours.md');
  assert.notEqual(first, second);
  assert.match(second, /\.md$/);
});

test('robots rules keep the longer match', () => {
  const robots = 'User-agent: *\nDisallow: /private\nAllow: /private/help\n';
  assert.equal(robotsAllows(robots, '/private/help'), true);
  assert.equal(robotsAllows(robots, '/private/notes'), false);
  assert.equal(robotsAllows(robots, '/hours'), true);
});

test('front matter records the source and a content hash', () => {
  const file = withFrontMatter({ title: 'Hours', source: 'https://example.com/hours', finalUrl: 'https://example.com/hours', markdown: 'Open weekdays.', fetchedAt: '2026-11-06T00:00:00.000Z' });
  assert.match(file.text, /^---\n/);
  assert.match(file.text, /source: "https:\/\/example.com\/hours"/);
  assert.match(file.text, /Open weekdays\./);
  assert.equal(file.hash.length, 16);
});
