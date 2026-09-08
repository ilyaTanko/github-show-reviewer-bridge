import { failure, record, sanitizeResponse, isReviewState } from '../protocol.ts';
import type { Request, Response, Pull, Review } from '../protocol.ts';
import { classifyError } from './github-cli.ts';
import type { RunQuery } from './github-cli.ts';

type Page = { done: boolean; cursor: string | null };
type Connection = { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor?: unknown } };

function isConnection(value: unknown): value is Connection {
  return record(value) && Array.isArray(value.nodes) && record(value.pageInfo) && typeof value.pageInfo.hasNextPage === 'boolean';
}

function isAdvancingCursor(value: unknown, previous: string | null): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && value !== previous;
}

function hasGraphqlErrors(value: Record<string, unknown>): boolean {
  return Array.isArray(value.errors) && value.errors.length > 0;
}

function hasRepositoryData(value: unknown): value is { repository: Record<string, unknown> } {
  return record(value) && record(value.repository);
}

function hasRequestedReviewer(value: unknown): value is { requestedReviewer: Record<string, unknown> } {
  return record(value) && record(value.requestedReviewer);
}

function isTeamActor(actor: Record<string, unknown>): actor is Record<string, unknown> & { slug: string } {
  return actor.__typename === 'Team' && typeof actor.slug === 'string';
}

type AuthoredReview = Record<string, unknown> & { author: Record<string, unknown> & { login: string } };
function isNonPendingAuthoredReview(value: unknown): value is AuthoredReview {
  return record(value) && record(value.author) && typeof value.author.login === 'string' && value.state !== 'PENDING';
}

function hasSubmittedReviewDetails(value: AuthoredReview): value is AuthoredReview & { state: Review['state']; submittedAt: string } {
  return isReviewState(value.state) && typeof value.submittedAt === 'string' && Number.isFinite(Date.parse(value.submittedAt));
}

function isReviewDecision(state: Review['state']): boolean {
  return state === 'APPROVED' || state === 'CHANGES_REQUESTED';
}

function shouldReplaceLatestReview(state: Review['state'], submittedAt: string, previous: { time: string; review: Review } | undefined): boolean {
  if (!previous) return true;
  const incomingIsDecision = isReviewDecision(state);
  const previousIsDecision = isReviewDecision(previous.review.state);
  if (incomingIsDecision !== previousIsDecision) return incomingIsDecision;
  return Date.parse(submittedAt) >= Date.parse(previous.time);
}

function isBridgeFailure(error: unknown): boolean {
  return record(error) && error.type === 'error' && typeof error.code === 'string';
}

function readNextPage(value: unknown, page: Page): unknown[] {
  if (!isConnection(value)) throw failure('TEMPORARY_FAILURE');
  if (value.pageInfo.hasNextPage) {
    const cursor = value.pageInfo.endCursor;
    if (!isAdvancingCursor(cursor, page.cursor)) throw failure('TEMPORARY_FAILURE');
    page.cursor = cursor;
  } else page.done = true;
  return value.nodes;
}
function cleanDisplayText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value : fallback;
  return text.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256);
}

type PullProgress = {
  number: number;
  requested: Page;
  reviewed: Page;
  pull: Pull;
  latest: Map<string, { time: string; review: Review }>;
};

function createPullProgress(number: number): PullProgress {
  return {
    number,
    requested: { done: false, cursor: null },
    reviewed: { done: false, cursor: null },
    pull: { requestedReviewers: [], reviews: [] },
    latest: new Map(),
  };
}

function hasUnreadPages(progress: PullProgress): boolean {
  return !progress.requested.done || !progress.reviewed.done;
}

function requestedReviewersField(page: Page): string {
  if (page.done) return '';
  return `reviewRequests(first:100,after:${JSON.stringify(page.cursor)}) {
    nodes {
      requestedReviewer {
        __typename
        ... on Actor { login }
        ... on User { userName: name }
        ... on Team { slug teamName: name }
      }
    }
    pageInfo { hasNextPage endCursor }
  }`;
}

function submittedReviewsField(page: Page): string {
  if (page.done) return '';
  return `reviews(first:100,after:${JSON.stringify(page.cursor)}) {
    nodes {
      author { login ... on User { name } }
      state
      submittedAt
    }
    pageInfo { hasNextPage endCursor }
  }`;
}

function buildReviewersQuery(pulls: PullProgress[]): string {
  const fields = pulls.filter(hasUnreadPages).map(progress => `p${progress.number}: pullRequest(number:${progress.number}) {
    author { login }
    ${requestedReviewersField(progress.requested)}
    ${submittedReviewsField(progress.reviewed)}
  }`).join('\n');
  return `query($owner:String!,$repo:String!) {
    repository(owner:$owner,name:$repo) { ${fields} }
  }`;
}

function readRepository(raw: unknown): Record<string, unknown> {
  if (!record(raw)) throw failure('TEMPORARY_FAILURE');
  if (hasGraphqlErrors(raw)) throw failure(classifyError(JSON.stringify(raw.errors)));
  if (!hasRepositoryData(raw.data)) throw failure('NOT_FOUND');
  return raw.data.repository;
}

function collectRequestedReviewers(value: unknown, progress: PullProgress): number {
  const nodes = readNextPage(value, progress.requested);
  for (const node of nodes) {
    if (!hasRequestedReviewer(node)) continue;
    const actor = node.requestedReviewer;
    if (isTeamActor(actor)) {
      progress.pull.requestedReviewers.push({
        kind: 'team',
        slug: cleanDisplayText(actor.slug, ''),
        displayName: cleanDisplayText(actor.teamName, actor.slug),
      });
    } else if (typeof actor.login === 'string') {
      progress.pull.requestedReviewers.push({
        kind: 'user',
        login: cleanDisplayText(actor.login, ''),
        displayName: cleanDisplayText(actor.userName, actor.login),
      });
    }
  }
  return nodes.length;
}

function isPullRequestAuthor(login: string, author: unknown): boolean {
  return record(author) && typeof author.login === 'string' && login.toLowerCase() === author.login.toLowerCase();
}

function collectLatestReviews(pr: Record<string, unknown>, progress: PullProgress): number {
  const nodes = readNextPage(pr.reviews, progress.reviewed);
  for (const node of nodes) {
    if (!isNonPendingAuthoredReview(node)) continue;
    if (!hasSubmittedReviewDetails(node)) throw failure('TEMPORARY_FAILURE');
    if (isPullRequestAuthor(node.author.login, pr.author)) continue;
    const login = cleanDisplayText(node.author.login, '');
    const previous = progress.latest.get(login);
    if (shouldReplaceLatestReview(node.state, node.submittedAt, previous)) {
      progress.latest.set(login, {
        time: node.submittedAt,
        review: { login, displayName: cleanDisplayText(node.author.name, login), state: node.state },
      });
    }
  }
  return nodes.length;
}

function collectRepositoryPage(repository: Record<string, unknown>, pulls: PullProgress[]): number {
  let nodeCount = 0;
  for (const progress of pulls.filter(hasUnreadPages)) {
    const pr = repository[`p${progress.number}`];
    if (!record(pr)) throw failure('NOT_FOUND');
    if (!progress.requested.done) nodeCount += collectRequestedReviewers(pr.reviewRequests, progress);
    if (!progress.reviewed.done) nodeCount += collectLatestReviews(pr, progress);
  }
  return nodeCount;
}

function buildReviewerResponse(request: Request, pulls: PullProgress[]): Response {
  const pullRequests: Record<string, Pull> = {};
  for (const progress of pulls) {
    pullRequests[progress.number] = {
      requestedReviewers: progress.pull.requestedReviewers,
      reviews: [...progress.latest.values()].map(entry => entry.review),
    };
  }
  return sanitizeResponse({
    version: 1,
    type: 'pullRequestReviewers',
    host: request.host,
    owner: request.owner,
    repo: request.repo,
    pullRequests,
  }, request);
}

export async function fetchReviewers(request: Request, run: RunQuery): Promise<Response> {
  const deadline = Date.now() + 15000;
  const pulls = request.pullNumbers.map(createPullProgress);
  try {
    let totalNodes = 0;
    while (pulls.some(hasUnreadPages)) {
      const timeout = deadline - Date.now();
      if (timeout <= 0) return failure('TEMPORARY_FAILURE');
      const raw = await run(buildReviewersQuery(pulls), request, timeout);
      totalNodes += collectRepositoryPage(readRepository(raw), pulls);
      // ponytail: fail explicitly beyond 50k nodes; narrower batches if huge repositories need more.
      if (totalNodes > 50000) return failure('TEMPORARY_FAILURE');
    }
    return buildReviewerResponse(request, pulls);
  } catch (error) {
    if (isBridgeFailure(error)) {
      const sanitized = sanitizeResponse(error, request);
      if (sanitized.type === 'error') return sanitized;
    }
    return failure('INTERNAL_ERROR');
  }
}
