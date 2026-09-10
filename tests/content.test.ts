import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { reviewIcons } from '../src/review-icons.ts';
import type { Request } from '../src/protocol.ts';

// A minimal DOM double for the existing GitHub row selectors; no browser dependency.
class Element {
  className = ''; textContent = ''; title = ''; href = ''; type = '';
  children: (Element | string)[] = [];
  attributes: Record<string, string> = {};
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  parent?: Element;
  get parentElement(): Element | null { return this.parent ?? null; }
  click?: () => void;
  get isConnected(): boolean { return this.parent !== undefined; }
  append(...children: (Element | string)[]) { for (const child of children) { if (child instanceof Element) child.parent = this; this.children.push(child); } }
  after(child: Element) {
    assert.ok(this.parent);
    child.parent = this.parent;
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, child);
  }
  replaceChildren(...children: (Element | string)[]) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = undefined; }
  closest(selector: string): Element | null {
    if (selector !== 'li') return null;
    for (let element: Element | undefined = this; element; element = element.parent) {
      if (element.attributes['data-list-item'] === 'true') return element;
    }
    return null;
  }
  addEventListener(_name: string, fn: () => void) { this.click = fn; }
  querySelector(selector: string): Element | null {
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      if ((selector.includes('a.Link--primary') && child.className === 'Link--primary') ||
          (selector.includes('a[data-testid="listitem-title-link"]') && child.attributes['data-testid'] === 'listitem-title-link')) return child;
      if (selector === '[data-testid="timestamp-container"]' && child.attributes['data-testid'] === 'timestamp-container') return child;
      if (selector.startsWith('.d-flex') && child.className === 'meta') return child;
      if (selector === '.github-show-reviewer' && child.className.includes('github-show-reviewer')) return child;
      const nested = child.querySelector(selector); if (nested) return nested;
    }
    return null;
  }
}
test('content batches canonical PR links, renders safely, retries and handles SPA navigation', async () => {
  const rows: Element[] = [];
  for (let i = 1; i <= 51; i++) {
    const row = new Element(); const link = new Element(); const meta = new Element();
    link.href = `https://github.example.internal/platform/frontend/pull/${i}`; link.className = 'Link--primary';
    meta.className = 'meta'; row.append(link, meta); rows.push(row);
  }
  // A DOM-supplied link to another host must never become command input.
  const bad = new Element(); const badLink = new Element(); const badMeta = new Element();
  badLink.href = 'https://evil.example/platform/frontend/pull/999'; badLink.className = 'Link--primary'; badMeta.className = 'meta'; bad.append(badLink, badMeta); rows.push(bad);
  const invalidRows = [
    'https://github.example.internal/other/frontend/pull/999',
    'https://github.example.internal/platform/other/pull/999',
    'https://github.example.internal/platform/frontend/issues/999',
    'https://github.example.internal/platform/frontend/pull/0',
    'https://github.example.internal/platform/frontend/pull/9007199254740992',
  ].map(href => {
    const row = new Element(); const link = new Element(); const meta = new Element();
    link.href = href; link.className = 'Link--primary'; meta.className = 'meta';
    row.append(link, meta); rows.push(row);
    return row;
  });
  const location = { href: 'https://github.example.internal/platform/frontend/pulls', hostname: 'github.example.internal', origin: 'https://github.example.internal', pathname: '/platform/frontend/pulls' };
  const timers = new Map<number, () => void>(); let timer = 0;
  let urlTick: () => void;
  let observe: () => void;
  const calls: Request[] = [];
  let error = false;
  const source = await readFile('dist/extension/content.js', 'utf8');
  runInNewContext(source, {
    URL, location,
    document: { body: new Element(), createElement: () => new Element(), createElementNS: () => new Element(), addEventListener() {}, querySelectorAll: (selector: string) => selector === '.js-issue-row' ? rows : selector === '[data-listview-component="items-list"] > li' ? [] : rows.map(r => r.querySelector('.github-show-reviewer')).filter(Boolean) },
    window: { addEventListener() {} },
    MutationObserver: class { constructor(fn: () => void) { observe = fn; } observe() {} },
    setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id: number) => timers.delete(id), setInterval: (fn: () => void) => { urlTick = fn; },
    chrome: { runtime: { sendMessage: async (request: Request) => {
      calls.push(request);
      if (error) return { version: 1, type: 'error', code: 'AUTH_REQUIRED', message: 'raw secret' };
      return { version: 1, type: 'pullRequestReviewers', host: request.host, owner: request.owner, repo: request.repo, pullRequests: Object.fromEntries(request.pullNumbers.map(n => [n, { requestedReviewers: n === 1 ? [{ kind: 'team', slug: '<img onerror=x>', displayName: 'Team' }] : [], reviews: n >= 3 && n <= 6 ? [{ login: 'alice', displayName: 'Alice', state: Object.keys(reviewIcons)[n - 3] }] : [] }])) };
    } } },
  });
  async function flush() { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); }
  await flush();
  assert.deepEqual(calls.map(r => r.pullNumbers.length), [50, 1]);
  assert.equal(bad.querySelector('.github-show-reviewer'), null);
  for (const row of invalidRows) assert.equal(row.querySelector('.github-show-reviewer'), null);
  const span = rows[0].querySelector('.github-show-reviewer')!;
  const meta = rows[0].querySelector('.d-flex.mt-1.text-small.color-fg-muted')!;
  assert.equal(meta.children.length, 0, 'Reviewer must not compete with the existing flex items');
  assert.equal(span.parent, meta.parent);
  assert.equal(rows[0].children.indexOf(span), rows[0].children.indexOf(meta) + 1);
  const link = span.children[1] as Element;
  assert.equal(link.textContent, '@<img onerror=x>');
  assert.equal(new URL(link.href).origin, location.origin);
  assert.equal(rows[1].querySelector('.github-show-reviewer')!.children[1], 'None');
  Object.entries(reviewIcons).forEach(([state, status], i) => {
    const reviewedLink = rows[i + 2].querySelector('.github-show-reviewer')!.children[1] as Element;
    assert.equal(reviewedLink.textContent, 'alice');
    assert.equal(reviewedLink.attributes['aria-label'], `alice: ${status.label}`);
    assert.equal(reviewedLink.title, `Alice: ${status.label}`);
    const svg = reviewedLink.children[0] as Element;
    assert.equal(svg.attributes.class, `review-status review-status--${state.toLowerCase()}`);
    assert.equal(svg.attributes['aria-hidden'], 'true');
    assert.equal(svg.children.length, status.paths.length);
    assert.ok((svg.children[0] as Element).attributes.d.length > 0);
  });
  observe!(); await flush(); assert.equal(calls.length, 2);
  error = true; location.href += '?q=is:open'; urlTick!(); await flush();
  const failed = rows[0].querySelector('.github-show-reviewer')!;
  assert.match(failed.textContent, /gh sign-in required/); assert.doesNotMatch(failed.textContent, /raw secret|N\/A/);
  error = false; (failed.children[0] as Element).click!(); await flush();
  assert.equal(calls.at(-1)!.pullNumbers.length, 1);
  location.pathname = '/platform/frontend/issues'; location.href = location.origin + location.pathname; urlTick!(); await flush();
  assert.equal(rows[0].querySelector('.github-show-reviewer'), null);
});

test('content supports the Preview pull-request list', async () => {
  const row = new Element(); const link = new Element(); const description = new Element(); const timestamp = new Element();
  row.attributes['data-list-item'] = 'true';
  timestamp.attributes['data-testid'] = 'timestamp-container';
  link.href = 'https://github.example.internal/platform/frontend/pull/1'; link.attributes['data-testid'] = 'listitem-title-link';
  description.append(timestamp); row.append(link, description);
  const location = { href: 'https://github.example.internal/platform/frontend/pulls?q=is%3Apr', hostname: 'github.example.internal', origin: 'https://github.example.internal', pathname: '/platform/frontend/pulls' };
  const timers = new Map<number, () => void>(); let timer = 0;
  let calls = 0;
  const source = await readFile('dist/extension/content.js', 'utf8');
  runInNewContext(source, {
    URL, location,
    document: { body: new Element(), createElement: () => new Element(), createElementNS: () => new Element(), addEventListener() {}, querySelectorAll: (selector: string) => selector === '.js-issue-row' ? [] : selector === '[data-listview-component="items-list"] > li' ? [row] : [row.querySelector('.github-show-reviewer')].filter(Boolean) },
    window: { addEventListener() {} }, MutationObserver: class { constructor(_fn: () => void) {} observe() {} },
    setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id: number) => timers.delete(id), setInterval() {},
    chrome: { runtime: { sendMessage: async (request: Request) => { calls++; return { version: 1, type: 'pullRequestReviewers', host: request.host, owner: request.owner, repo: request.repo, pullRequests: { 1: { requestedReviewers: [], reviews: [] } } }; } } },
  });
  const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  const span = row.querySelector('.github-show-reviewer');
  assert.ok(span);
  assert.equal(span.parent, row);
  assert.equal(row.children.indexOf(span!), row.children.indexOf(description) + 1);
});
