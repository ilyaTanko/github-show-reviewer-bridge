import { failure, isPullNumber, sanitizeResponse, validateRequest } from './protocol.ts';
import { reviewIcons } from './review-icons.ts';
import type { Failure, Pull, Request, Response, Review } from './protocol.ts';

const cssClass = 'github-show-reviewer';
let lastUrl = '';
let generation = 0;
const seen = new WeakMap<Element, string>();
let timer: ReturnType<typeof setTimeout>;
function schedule() { clearTimeout(timer); timer = setTimeout(() => { void scan(); }, 100); }
type ReviewerLabel = { label: string; name: string; state?: Review['state']; query: string };
type ReviewerRow = { row: Element; span: HTMLElement; number: number };

function reviewerLabels(pull: Pull, owner: string): ReviewerLabel[] {
  return [
    ...pull.requestedReviewers.map(reviewer => ({
      label: reviewer.kind === 'team' ? `@${reviewer.slug}` : reviewer.login,
      name: reviewer.displayName,
      query: reviewer.kind === 'team' ? `team-review-requested:${owner}/${reviewer.slug}` : `review-requested:${reviewer.login}`,
    })),
    ...pull.reviews.map(review => ({ label: review.login, name: review.displayName, state: review.state, query: `reviewed-by:${review.login}` })),
  ];
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

function createReviewerLink(reviewer: ReviewerLabel, request: Request): HTMLAnchorElement {
  const link = document.createElement('a');
  const url = new URL(`/${request.owner}/${request.repo}/pulls`, location.origin);
  url.searchParams.set('q', `is:pr sort:updated-desc ${reviewer.query}`);
  link.href = url.href;
  link.textContent = reviewer.label;
  link.title = reviewer.name;
  link.className = 'reviewer-link';
  if (reviewer.state) {
    const status = reviewIcons[reviewer.state];
    link.title = `${reviewer.name}: ${status.label}`;
    link.setAttribute('aria-label', `${reviewer.label}: ${status.label}`);
    link.append(createReviewStatusIcon(reviewer.state));
  }
  return link;
}

function renderReviewers(span: HTMLElement, pull: Pull, request: Request) {
  span.replaceChildren('Reviewer: ');
  const labels = reviewerLabels(pull, request.owner);
  if (!labels.length) span.append('None');
  labels.forEach((reviewer, index) => {
    if (index) span.append(', ');
    span.append(createReviewerLink(reviewer, request));
  });
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

function prepareReviewerRow(row: Element, owner: string, repo: string): ReviewerRow | undefined {
  const link = row.querySelector<HTMLAnchorElement>('a.Link--primary[href*="/pull/"]') ??
    row.querySelector<HTMLAnchorElement>('a[data-testid="listitem-title-link"]');
  if (!link) return;
  const url = new URL(link.href, location.href);
  const path = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!isRepositoryPullUrl(url, path, owner, repo)) return;
  const identity = `${generation}/${url.pathname}`;
  if (hasReviewerDisplay(row, identity)) return;
  const meta = row.querySelector<HTMLElement>('.d-flex.mt-1.text-small.color-fg-muted') ??
    link.closest('li')?.querySelector<HTMLElement>('[data-testid="timestamp-container"]')?.parentElement;
  if (!meta) return;
  const number = Number(path[3]);
  if (!isPullNumber(number)) return;
  row.querySelector(`.${cssClass}`)?.remove();
  const span = document.createElement('span');
  span.className = `${cssClass} text-small`;
  span.textContent = 'Reviewer: Loading…';
  meta.after(span);
  seen.set(row, identity);
  return { row, span, number };
}

async function requestReviewers(request: Request): Promise<Response> {
  try { return sanitizeResponse(await chrome.runtime.sendMessage(request), request); }
  catch { return failure('TEMPORARY_FAILURE'); }
}

function renderRetry({ row, span }: ReviewerRow, response: Failure) {
  span.textContent = response.code === 'AUTH_REQUIRED' ? 'Reviewer: gh sign-in required ' : `Reviewer: ${response.message} `;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Retry';
  button.addEventListener('click', () => { seen.delete(row); schedule(); });
  span.append(button);
}

async function scan() {
  if (lastUrl !== location.href) {
    lastUrl = location.href; generation++;
    document.querySelectorAll(`.${cssClass}`).forEach(node => node.remove());
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
      if (response.type === 'pullRequestReviewers') renderReviewers(entry.span, response.pullRequests[entry.number], request);
      else renderRetry(entry, response);
    }
  }
}
new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
document.addEventListener('turbo:load', schedule);
window.addEventListener('popstate', schedule);
setInterval(() => { if (lastUrl !== location.href) schedule(); }, 1000);
schedule();
