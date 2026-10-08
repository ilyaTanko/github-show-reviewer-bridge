import { failure, isPullNumber, sanitizeResponse, validateRequest } from './protocol.ts';
import { reviewIcons } from './review-icons.ts';
import type { Failure, Pull, Request, Response, Review } from './protocol.ts';

const cssClass = 'github-show-reviewer';
let lastUrl = '';
let generation = 0;
const seen = new WeakMap<Element, string>();
let timer: ReturnType<typeof setTimeout>;
function schedule() { clearTimeout(timer); timer = setTimeout(() => { void scan(); }, 100); }
// `requested` wins over `state`: a reviewer who reviewed and was requested again is pending again.
type ReviewerLabel = { label: string; login: string; name: string; team: boolean; requested: boolean; state?: Review['state']; query: string };
type ReviewerRow = { row: Element; span: HTMLElement; number: number };

// Inline avatar UI adapted from elanza-nl/github-pr-enhancer: review-state rings on the PR metadata line
// and a "Pending reviews by" filter bar. Reviewer data still comes from the local gh bridge.
const hiddenClass = 'github-show-reviewer-hidden';
const ROW_SELECTOR = '.js-issue-row, [data-listview-component="items-list"] > li';
const MAX_VISIBLE = 5;
// Primer Octicons `people` (MIT). Static markup; never interpolate page or bridge data into it.
const TEAM_ICON = '<svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16" class="octicon octicon-people"><path d="M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.507 3.507 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z"></path></svg>';
let filterBar: HTMLElement | undefined;
let activeFilter: string | undefined;
const rowReviewers = new WeakMap<Element, ReviewerLabel[]>();
const allReviewers = new Map<string, ReviewerLabel>();

function reviewerLabels(pull: Pull, owner: string): ReviewerLabel[] {
  const labels: ReviewerLabel[] = [
    ...pull.requestedReviewers.map(reviewer => ({
      label: reviewer.kind === 'team' ? `@${reviewer.slug}` : reviewer.login,
      login: reviewer.kind === 'team' ? reviewer.slug : reviewer.login,
      name: reviewer.displayName,
      team: reviewer.kind === 'team',
      requested: true,
      query: reviewer.kind === 'team' ? `team-review-requested:${owner}/${reviewer.slug}` : `review-requested:${reviewer.login}`,
    })),
    ...pull.reviews.map(review => ({ label: review.login, login: review.login, name: review.displayName, team: false, requested: false, state: review.state, query: `reviewed-by:${review.login}` })),
  ];
  // One avatar per reviewer: a later review only adds its state to the earlier entry.
  const merged = new Map<string, ReviewerLabel>();
  for (const reviewer of labels) {
    const existing = merged.get(reviewer.label);
    if (!existing) merged.set(reviewer.label, reviewer);
    else if (reviewer.state) existing.state = reviewer.state;
  }
  return [...merged.values()];
}

function createReviewStatusIcon(state: Review['state']): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const attributes = { viewBox: '0 0 16 16', width: '16', height: '16', fill: 'currentColor', 'aria-hidden': 'true', focusable: 'false', class: `review-status review-status--${state.toLowerCase()}` };
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
  for (const pathAttributes of reviewIcons[state].paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [key, value] of Object.entries(pathAttributes)) path.setAttribute(key, value);
    svg.append(path);
  }
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const separator = () => el('span', 'reviewer-separator', '•');

function teamIcon(): Node {
  const holder = el('span');
  holder.innerHTML = TEAM_ICON;
  return holder.firstChild!;
}

function avatar(login: string, className?: string): HTMLImageElement {
  const img = el('img', className);
  // `/<login>.png` is served by github.com and GitHub Enterprise Server alike.
  img.src = `${location.origin}/${encodeURIComponent(login)}.png?size=40`;
  img.alt = '';
  img.loading = 'lazy';
  return img;
}

const isDecision = (state?: Review['state']) => state === 'APPROVED' || state === 'CHANGES_REQUESTED';
const isPending = (reviewer?: ReviewerLabel) => reviewer !== undefined && (reviewer.requested || !isDecision(reviewer.state));

function describe(reviewer: ReviewerLabel): string {
  const status = reviewer.requested
    ? (reviewer.state ? `Review requested again (was: ${reviewIcons[reviewer.state].label})` : 'Review requested')
    : reviewer.state && reviewIcons[reviewer.state].label;
  return status ? `${reviewer.label}: ${status}` : reviewer.label;
}

function createReviewerLink(reviewer: ReviewerLabel, request: Request): HTMLAnchorElement {
  const link = document.createElement('a');
  const url = new URL(`/${request.owner}/${request.repo}/pulls`, location.origin);
  url.searchParams.set('q', `is:pr sort:updated-desc ${reviewer.query}`);
  link.href = url.href;
  const label = describe(reviewer);
  link.setAttribute('aria-label', label);
  link.title = reviewer.name && reviewer.name !== reviewer.login ? `${reviewer.name} (${label})` : label;
  if (reviewer.team) {
    link.className = 'reviewer-team-badge';
    link.append(teamIcon(), el('span', 'team-name', reviewer.label));
    return link;
  }
  const ring = reviewer.requested ? '' : reviewer.state === 'APPROVED' ? ' reviewer-state-approved'
    : reviewer.state === 'CHANGES_REQUESTED' ? ' reviewer-state-changes-requested' : '';
  link.className = `reviewer-avatar-link${ring}`;
  link.append(avatar(reviewer.login, 'reviewer-avatar'));
  // Rings cover approvals and change requests; other review states get a small Octicon badge.
  if (!reviewer.requested && reviewer.state && !isDecision(reviewer.state)) link.append(createReviewStatusIcon(reviewer.state));
  return link;
}

function renderReviewers({ row, span }: ReviewerRow, pull: Pull, request: Request) {
  span.replaceChildren(separator());
  const labels = reviewerLabels(pull, request.owner);
  rowReviewers.set(row, labels);
  for (const reviewer of labels) allReviewers.set(reviewer.label, reviewer);
  filterRow(row);
  if (!labels.length) {
    span.append('Reviewer: ', el('span', 'reviewer-none', 'None'));
    return;
  }
  const container = el('span', 'reviewer-avatars-container');
  for (const reviewer of labels.slice(0, MAX_VISIBLE)) container.append(createReviewerLink(reviewer, request));
  const overflow = labels.slice(MAX_VISIBLE);
  if (overflow.length) {
    const badge = el('span', 'reviewer-overflow-badge', `+${overflow.length}`);
    badge.title = overflow.map(describe).join(', ');
    container.append(badge);
  }
  span.append(container);
}

function countPending(label: string): number {
  let count = 0;
  for (const row of document.querySelectorAll(ROW_SELECTOR)) {
    if (isPending(rowReviewers.get(row)?.find(reviewer => reviewer.label === label))) count++;
  }
  return count;
}

// The filter only hides rows on the current page; the avatar links search across all pages.
function filterRow(row: Element) {
  const hide = activeFilter !== undefined && !isPending(rowReviewers.get(row)?.find(reviewer => reviewer.label === activeFilter));
  row.classList.toggle(hiddenClass, hide);
}

function toggleFilter(label: string) {
  activeFilter = activeFilter === label ? undefined : label;
  renderFilterBar();
  document.querySelectorAll(ROW_SELECTOR).forEach(filterRow);
}

function ensureFilterBar(): HTMLElement | undefined {
  if (filterBar?.isConnected) return filterBar;
  document.querySelectorAll(`.${cssClass}-filter`).forEach(node => node.remove());
  filterBar = undefined;
  const firstRow = document.querySelector(ROW_SELECTOR);
  // The newer list view keeps its rows in a React-managed <ul>; insert before the list so React never removes the bar.
  const list = firstRow?.closest('ul[data-listview-component="items-list"]') ?? firstRow;
  if (!list?.parentNode) return;
  const bar = el('div', `${cssClass}-filter`);
  bar.hidden = true;
  list.parentNode.insertBefore(bar, list);
  bar.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLElement>('[data-key]');
    if (button && bar.contains(button)) toggleFilter(button.dataset.key!);
  });
  filterBar = bar;
  return bar;
}

function renderFilterBar() {
  const bar = ensureFilterBar();
  if (!bar) return;
  const sorted = [...allReviewers.values()].sort((a, b) => a.login.localeCompare(b.login, undefined, { sensitivity: 'base' }));
  const nodes: Node[] = [el('span', 'reviewer-filter-label', 'Pending reviews by:')];
  for (const reviewer of sorted) {
    const count = countPending(reviewer.label);
    if (!count) continue;
    const active = activeFilter === reviewer.label;
    const kind = reviewer.team ? 'reviewer-filter-team' : 'reviewer-filter-avatar';
    const button = el('button', `${kind}${active ? ` ${kind}--active` : ''}`);
    button.type = 'button';
    button.dataset.key = reviewer.label;
    button.title = `${reviewer.label}: ${count} pending`;
    button.setAttribute('aria-label', `Show only pull requests pending review by ${reviewer.label} (${count})`);
    button.setAttribute('aria-pressed', String(active));
    button.append(reviewer.team ? teamIcon() : avatar(reviewer.login));
    button.append(el('span', 'reviewer-filter-count', count > 99 ? '99+' : String(count)));
    nodes.push(button);
  }
  bar.replaceChildren(...nodes);
  bar.hidden = nodes.length === 1;
}

function resetFilter() {
  document.querySelectorAll(`.${hiddenClass}`).forEach(node => node.classList.remove(hiddenClass));
  allReviewers.clear();
  activeFilter = undefined;
  filterBar?.remove();
  filterBar = undefined;
}

function isRepositoryPullUrl(url: URL, path: RegExpMatchArray | null, owner: string, repo: string): path is RegExpMatchArray {
  return url.origin === location.origin && path !== null && path[1] === owner && path[2] === repo;
}

function hasReviewerDisplay(row: Element, identity: string): boolean {
  return seen.get(row) === identity && row.querySelector(`.${cssClass}`) !== null;
}

function isCurrentScan(current: number): boolean {
  return current === generation && lastUrl === location.href;
}

// Join the PR's own metadata line instead of adding a line, so the compact list view stays compact.
function mountSpan(row: Element, link: HTMLAnchorElement, span: HTMLElement): boolean {
  const container = row.querySelector<HTMLElement>('.d-flex.mt-1.text-small.color-fg-muted, [class*="Description-module__container"]');
  if (container) {
    let inline = container.querySelector<HTMLElement>('.d-none.d-md-inline-flex');
    if (!inline) {
      inline = el('span', 'd-none d-md-inline-flex');
      container.append(inline);
    }
    inline.append(span);
    return true;
  }
  const meta = link.closest('li')?.querySelector<HTMLElement>('[data-testid="timestamp-container"]')?.parentElement;
  if (!meta) return false;
  meta.after(span);
  return true;
}

function prepareReviewerRow(row: Element, owner: string, repo: string): ReviewerRow | undefined {
  const link = row.querySelector<HTMLAnchorElement>('a.Link--primary[href*="/pull/"]') ??
    row.querySelector<HTMLAnchorElement>('a[data-testid="listitem-title-link"]');
  if (!link) return;
  const url = new URL(link.href, location.href);
  const path = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!isRepositoryPullUrl(url, path, owner, repo)) return;
  const identity = `${generation}/${url.pathname}`;
  if (hasReviewerDisplay(row, identity)) return;
  const number = Number(path[3]);
  if (!isPullNumber(number)) return;
  row.querySelector(`.${cssClass}`)?.remove();
  const span = document.createElement('span');
  span.className = `${cssClass} issue-meta-section`;
  span.append(separator(), 'Reviewer: Loading…');
  if (!mountSpan(row, link, span)) return;
  seen.set(row, identity);
  return { row, span, number };
}

async function requestReviewers(request: Request): Promise<Response> {
  try { return sanitizeResponse(await chrome.runtime.sendMessage(request), request); }
  catch { return failure('TEMPORARY_FAILURE'); }
}

function renderRetry({ row, span }: ReviewerRow, response: Failure) {
  const text = response.code === 'AUTH_REQUIRED' ? 'Reviewer: gh sign-in required ' : `Reviewer: ${response.message} `;
  span.replaceChildren(separator(), el('span', 'reviewer-na', text));
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reviewer-retry';
  button.textContent = 'Retry';
  button.addEventListener('click', () => { seen.delete(row); schedule(); });
  span.append(button);
}

async function scan() {
  if (lastUrl !== location.href) {
    lastUrl = location.href; generation++;
    document.querySelectorAll(`.${cssClass}`).forEach(node => node.remove());
    resetFilter();
  }
  const page = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pulls\/?$/);
  if (!page) return;
  const current = generation;
  const rows: ReviewerRow[] = [];
  const rowsOnPage = [
    ...document.querySelectorAll('.js-issue-row'),
    ...document.querySelectorAll('[data-listview-component="items-list"] > li'),
  ];
  for (const row of rowsOnPage) {
    const prepared = prepareReviewerRow(row, page[1], page[2]);
    if (prepared) rows.push(prepared);
  }
  for (let offset = 0; offset < rows.length; offset += 50) {
    if (current !== generation) return;
    const batch = rows.slice(offset, offset + 50);
    const request = validateRequest({ version: 1, type: 'getPullRequestReviewers', host: location.hostname, owner: page[1], repo: page[2], pullNumbers: batch.map(r => r.number) }, [location.hostname]);
    if (request.type === 'error') return;
    const response = await requestReviewers(request);
    if (!isCurrentScan(current)) return;
    for (const entry of batch) {
      if (!entry.span.isConnected) continue;
      if (response.type === 'pullRequestReviewers') renderReviewers(entry, response.pullRequests[entry.number], request);
      else renderRetry(entry, response);
    }
    renderFilterBar();
  }
}
new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
document.addEventListener('turbo:load', schedule);
window.addEventListener('popstate', schedule);
setInterval(() => { if (lastUrl !== location.href) schedule(); }, 1000);
schedule();
