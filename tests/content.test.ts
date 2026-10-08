import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { reviewIcons } from '../src/review-icons.ts';
import type { Pull, Request } from '../src/protocol.ts';

// A minimal DOM double for the existing GitHub row selectors; no browser dependency.
const innerHtmlWrites: string[] = [];
class Element {
  className = ''; title = ''; href = ''; type = ''; src = ''; hidden = false;
  children: (Element | string)[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  parent?: Element;
  get parentElement(): Element | null { return this.parent ?? null; }
  get parentNode(): Element | null { return this.parent ?? null; }
  get firstChild(): Element | string | undefined { return this.children[0]; }
  get textContent(): string { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(value); }
  set innerHTML(value: string) { innerHtmlWrites.push(value); this.replaceChildren(new Element()); }
  get classList() {
    const without = (name: string) => this.className.split(' ').filter(c => c && c !== name);
    return {
      contains: (name: string) => this.className.split(' ').includes(name),
      toggle: (name: string, force: boolean) => { this.className = [...without(name), ...(force ? [name] : [])].join(' '); },
      remove: (name: string) => { this.className = without(name).join(' '); },
    };
  }
  listener?: (event: { target: Element }) => void;
  get isConnected(): boolean { return this.parent !== undefined; }
  append(...children: (Element | string)[]) { for (const child of children) { if (child instanceof Element) child.parent = this; this.children.push(child); } }
  insertBefore(child: Element, reference: Element) { child.parent = this; this.children.splice(this.children.indexOf(reference), 0, child); }
  after(child: Element) {
    assert.ok(this.parent);
    child.parent = this.parent;
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, child);
  }
  replaceChildren(...children: (Element | string)[]) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = undefined; }
  contains(other: Element): boolean { for (let element: Element | undefined = other; element; element = element.parent) if (element === this) return true; return false; }
  closest(selector: string): Element | null {
    for (let element: Element | undefined = this; element; element = element.parent) {
      if (selector === 'li' && element.attributes['data-list-item'] === 'true') return element;
      if (selector === 'ul[data-listview-component="items-list"]' && element.attributes['data-listview-component'] === 'items-list') return element;
      if (selector === '[data-key]' && element.dataset.key !== undefined) return element;
    }
    return null;
  }
  addEventListener(_name: string, fn: (event: { target: Element }) => void) { this.listener = fn; }
  click() { for (let element: Element | undefined = this; element; element = element.parent) element.listener?.({ target: this }); }
  querySelector(selector: string): Element | null {
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      if ((selector.includes('a.Link--primary') && child.className === 'Link--primary') ||
          (selector.includes('a[data-testid="listitem-title-link"]') && child.attributes['data-testid'] === 'listitem-title-link')) return child;
      if (selector === '[data-testid="timestamp-container"]' && child.attributes['data-testid'] === 'timestamp-container') return child;
      if (selector.startsWith('.d-flex') && child.className === 'meta') return child;
      if (selector.includes('Description-module__container') && child.className.includes('Description-module__container')) return child;
      if (selector === '.d-none.d-md-inline-flex' && child.className === 'd-none d-md-inline-flex') return child;
      if (selector === '.github-show-reviewer' && child.className.includes('github-show-reviewer')) return child;
      const nested = child.querySelector(selector); if (nested) return nested;
    }
    return null;
  }
}
const rowSelector = '.js-issue-row, [data-listview-component="items-list"] > li';
const filterBarOf = (list: Element) => list.children.filter(c => c instanceof Element && c.className === 'github-show-reviewer-filter') as Element[];

test('content batches canonical PR links, renders avatars safely, filters, retries and handles SPA navigation', async () => {
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
  const list = new Element(); list.append(...rows);
  const user = (login: string) => ({ kind: 'user' as const, login, displayName: login.toUpperCase() });
  const pulls: Record<number, Pull> = {
    7: { requestedReviewers: [user('bob')], reviews: [{ login: 'bob', displayName: 'bob', state: 'APPROVED' }, { login: 'renovate[bot]', displayName: 'renovate[bot]', state: 'COMMENTED' }] },
    8: { requestedReviewers: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(user), reviews: [] },
  };
  const location = { href: 'https://github.example.internal/platform/frontend/pulls', hostname: 'github.example.internal', origin: 'https://github.example.internal', pathname: '/platform/frontend/pulls' };
  const timers = new Map<number, () => void>(); let timer = 0;
  let urlTick: () => void;
  let observe: () => void;
  const calls: Request[] = [];
  let error = false;
  const source = await readFile('dist/extension/content.js', 'utf8');
  runInNewContext(source, {
    URL, location,
    document: { body: new Element(), createElement: () => new Element(), createElementNS: () => new Element(), addEventListener() {}, querySelector: (selector: string) => selector === rowSelector ? rows[0] : null, querySelectorAll: (selector: string) => selector === '.js-issue-row' || selector === rowSelector ? rows : selector === '[data-listview-component="items-list"] > li' ? [] : selector === '.github-show-reviewer-filter' ? filterBarOf(list) : selector === '.github-show-reviewer-hidden' ? rows.filter(r => r.classList.contains('github-show-reviewer-hidden')) : rows.map(r => r.querySelector('.github-show-reviewer')).filter(Boolean) },
    window: { addEventListener() {} },
    MutationObserver: class { constructor(fn: () => void) { observe = fn; } observe() {} },
    setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id: number) => timers.delete(id), setInterval: (fn: () => void) => { urlTick = fn; },
    chrome: { runtime: { sendMessage: async (request: Request) => {
      calls.push(request);
      if (error) return { version: 1, type: 'error', code: 'AUTH_REQUIRED', message: 'raw secret' };
      return { version: 1, type: 'pullRequestReviewers', host: request.host, owner: request.owner, repo: request.repo, pullRequests: Object.fromEntries(request.pullNumbers.map(n => [n, pulls[n] ?? { requestedReviewers: n === 1 ? [{ kind: 'team', slug: '<img onerror=x>', displayName: 'Team' }] : [], reviews: n >= 3 && n <= 6 ? [{ login: 'alice', displayName: 'Alice', state: Object.keys(reviewIcons)[n - 3] }] : [] }])) };
    } } },
  });
  async function flush() { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); }
  await flush();
  assert.deepEqual(calls.map(r => r.pullNumbers.length), [50, 1]);
  assert.equal(bad.querySelector('.github-show-reviewer'), null);
  for (const row of invalidRows) assert.equal(row.querySelector('.github-show-reviewer'), null);
  const span = rows[0].querySelector('.github-show-reviewer')!;
  const meta = rows[0].querySelector('.d-flex.mt-1.text-small.color-fg-muted')!;
  assert.equal(span.parent, meta.children[0], 'Reviewer joins the existing metadata line instead of adding a row');
  assert.equal((meta.children[0] as Element).className, 'd-none d-md-inline-flex');
  const link = (span.children[1] as Element).children[0] as Element;
  assert.equal(link.textContent, '@<img onerror=x>');
  assert.equal(new URL(link.href).origin, location.origin);
  assert.equal(new URL(link.href).searchParams.get('q'), 'is:pr sort:updated-desc team-review-requested:platform/<img onerror=x>');
  assert.deepEqual([...new Set(innerHtmlWrites)].map(html => /onerror/.test(html)), [false], 'The only innerHTML is the static team icon');
  assert.equal(rows[1].querySelector('.github-show-reviewer')!.textContent, '•Reviewer: None');
  Object.entries(reviewIcons).forEach(([state, status], i) => {
    const reviewedLink = (rows[i + 2].querySelector('.github-show-reviewer')!.children[1] as Element).children[0] as Element;
    assert.equal((reviewedLink.children[0] as Element).src, 'https://github.example.internal/alice.png?size=40');
    assert.equal(reviewedLink.attributes['aria-label'], `alice: ${status.label}`);
    assert.equal(reviewedLink.title, `Alice (alice: ${status.label})`);
    // Decisions are rings; other review states get an Octicon badge.
    const ring = state === 'APPROVED' ? ' reviewer-state-approved' : state === 'CHANGES_REQUESTED' ? ' reviewer-state-changes-requested' : '';
    assert.equal(reviewedLink.className, `reviewer-avatar-link${ring}`);
    if (ring) { assert.equal(reviewedLink.children.length, 1); return; }
    const svg = reviewedLink.children[1] as Element;
    assert.equal(svg.attributes.class, `review-status review-status--${state.toLowerCase()}`);
    assert.equal(svg.attributes['aria-hidden'], 'true');
    assert.equal(svg.children.length, status.paths.length);
    assert.ok((svg.children[0] as Element).attributes.d.length > 0);
  });
  // A re-requested reviewer is pending again; bots are shown like any other reviewer.
  const [bob, bot] = (rows[6].querySelector('.github-show-reviewer')!.children[1] as Element).children as Element[];
  assert.equal(bob.className, 'reviewer-avatar-link');
  assert.equal(bob.title, 'BOB (bob: Review requested again (was: Approved))');
  assert.equal(new URL(bob.href).searchParams.get('q'), 'is:pr sort:updated-desc review-requested:bob');
  assert.equal((bot.children[0] as Element).src, 'https://github.example.internal/renovate%5Bbot%5D.png?size=40');
  // At most five avatars, then an overflow badge listing the rest.
  const avatars = (rows[7].querySelector('.github-show-reviewer')!.children[1] as Element).children as Element[];
  assert.equal(avatars.length, 6);
  assert.equal(avatars[5].textContent, '+2');
  assert.equal(avatars[5].title, 'f: Review requested, g: Review requested');
  // The filter bar sits above the rows and has one button per reviewer with pending reviews.
  const bar = list.children[0] as Element;
  assert.equal(bar.className, 'github-show-reviewer-filter');
  assert.equal(bar.hidden, false);
  const buttons = () => Object.fromEntries((bar.children.slice(1) as Element[]).map(button => [button.dataset.key, button]));
  assert.deepEqual(Object.keys(buttons()), ['@<img onerror=x>', 'a', 'alice', 'b', 'bob', 'c', 'd', 'e', 'f', 'g', 'renovate[bot]']);
  assert.equal(buttons().alice.textContent, '2');
  const visible = () => rows.flatMap((row, i) => row.classList.contains('github-show-reviewer-hidden') ? [] : [i + 1]);
  (buttons().alice.children[0] as Element).click();
  assert.deepEqual(visible(), [5, 6]);
  assert.equal(buttons().alice.attributes['aria-pressed'], 'true');
  buttons().alice.click();
  assert.equal(visible().length, rows.length);
  buttons().bob.click();
  assert.deepEqual(visible(), [7]);
  observe!(); await flush(); assert.equal(calls.length, 2);
  error = true; location.href += '?q=is:open'; urlTick!(); await flush();
  assert.equal(visible().length, rows.length);
  assert.equal(filterBarOf(list).length, 1);
  assert.equal(filterBarOf(list)[0].hidden, true);
  const failed = rows[0].querySelector('.github-show-reviewer')!;
  assert.match(failed.textContent, /gh sign-in required/); assert.doesNotMatch(failed.textContent, /raw secret|N\/A/);
  error = false; (failed.children[2] as Element).click!(); await flush();
  assert.equal(calls.at(-1)!.pullNumbers.length, 1);
  assert.deepEqual(filterBarOf(list)[0].children.slice(1).map(button => (button as Element).dataset.key), ['@<img onerror=x>']);
  location.pathname = '/platform/frontend/issues'; location.href = location.origin + location.pathname; urlTick!(); await flush();
  assert.equal(rows[0].querySelector('.github-show-reviewer'), null);
  assert.equal(filterBarOf(list).length, 0);
});

test('content supports the Preview pull-request list', async () => {
  const row = new Element(); const link = new Element(); const description = new Element(); const timestamp = new Element();
  row.attributes['data-list-item'] = 'true';
  timestamp.attributes['data-testid'] = 'timestamp-container';
  link.href = 'https://github.example.internal/platform/frontend/pull/1'; link.attributes['data-testid'] = 'listitem-title-link';
  description.append(timestamp); row.append(link, description);
  // GitHub's newer markup has no timestamp container; reviewers join the description line instead.
  const moduleRow = new Element(); const moduleLink = new Element(); const moduleDescription = new Element();
  moduleRow.attributes['data-list-item'] = 'true';
  moduleLink.href = 'https://github.example.internal/platform/frontend/pull/2'; moduleLink.attributes['data-testid'] = 'listitem-title-link';
  moduleDescription.className = 'Description-module__container__abc12'; moduleRow.append(moduleLink, moduleDescription);
  const items = new Element(); items.attributes['data-listview-component'] = 'items-list'; items.append(row, moduleRow);
  const listParent = new Element(); listParent.append(items);
  const location = { href: 'https://github.example.internal/platform/frontend/pulls?q=is%3Apr', hostname: 'github.example.internal', origin: 'https://github.example.internal', pathname: '/platform/frontend/pulls' };
  const timers = new Map<number, () => void>(); let timer = 0;
  let calls = 0;
  const source = await readFile('dist/extension/content.js', 'utf8');
  runInNewContext(source, {
    URL, location,
    document: { body: new Element(), createElement: () => new Element(), createElementNS: () => new Element(), addEventListener() {}, querySelector: (selector: string) => selector === rowSelector ? row : null, querySelectorAll: (selector: string) => selector === '.js-issue-row' ? [] : selector === '[data-listview-component="items-list"] > li' || selector === rowSelector ? [row, moduleRow] : selector === '.github-show-reviewer-filter' ? filterBarOf(listParent) : selector === '.github-show-reviewer-hidden' ? [] : [row.querySelector('.github-show-reviewer')].filter(Boolean) },
    window: { addEventListener() {} }, MutationObserver: class { constructor(_fn: () => void) {} observe() {} },
    setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id: number) => timers.delete(id), setInterval() {},
    chrome: { runtime: { sendMessage: async (request: Request) => { calls++; return { version: 1, type: 'pullRequestReviewers', host: request.host, owner: request.owner, repo: request.repo, pullRequests: { 1: { requestedReviewers: [], reviews: [] }, 2: { requestedReviewers: [], reviews: [] } } }; } } },
  });
  const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  const span = row.querySelector('.github-show-reviewer');
  assert.ok(span);
  assert.equal(span.parent, row);
  assert.equal(row.children.indexOf(span!), row.children.indexOf(description) + 1);
  assert.equal(moduleRow.querySelector('.github-show-reviewer')!.parent!.parent, moduleDescription);
  // React owns the <ul>; the filter bar goes before it, never inside it.
  assert.equal(listParent.children[0], filterBarOf(listParent)[0]);
});
