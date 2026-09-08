export const HOST_NAME = 'com.github_show_reviewer.bridge';
export const messages = {
  INVALID_REQUEST: 'Invalid reviewer request.',
  UNSUPPORTED_HOST: 'This GitHub host is not configured.',
  GH_NOT_FOUND: 'Install GitHub CLI and reinstall the bridge.',
  AUTH_REQUIRED: 'GitHub CLI is not authenticated for this host.',
  ACCESS_DENIED: 'GitHub access denied.',
  NOT_FOUND: 'Pull request or repository is not accessible.',
  RATE_LIMITED: 'GitHub rate limit reached. Retry later.',
  TEMPORARY_FAILURE: 'Reviewers unavailable. Check the bridge installation and retry.',
  INTERNAL_ERROR: 'The bridge could not complete the request.',
} as const;
export type ErrorCode = keyof typeof messages;
export type Failure = { version: 1; type: 'error'; code: ErrorCode; message: string };
export const failure = (code: ErrorCode): Failure => ({ version: 1, type: 'error', code, message: messages[code] });
export type Request = {
  version: 1; type: 'getPullRequestReviewers'; host: string; owner: string; repo: string; pullNumbers: number[];
};
export type Reviewer = { kind: 'user'; login: string; displayName: string } | { kind: 'team'; slug: string; displayName: string };
export const states = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'] as const;
export type Review = { login: string; displayName: string; state: typeof states[number] };
export type Pull = { requestedReviewers: Reviewer[]; reviews: Review[] };
export type Success = { version: 1; type: 'pullRequestReviewers'; host: string; owner: string; repo: string; pullRequests: Record<string, Pull> };
export type Response = Success | Failure;
export const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function isDomainNameShape(value: string): boolean {
  return value.length <= 253 && value.includes('.');
}

export function validHost(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!isDomainNameShape(value)) return false;
  const hasValidLabels = value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  const isIpv4Address = /^\d+(\.\d+){3}$/.test(value);
  return hasValidLabels && !isIpv4Address;
}

function isRepositoryOwner(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(value);
}

function isRepositoryName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) && !['.', '..'].includes(value);
}

export function isPullNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isHostAllowlist(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(validHost);
}

export function isReviewState(value: unknown): value is Review['state'] {
  return states.includes(value as Review['state']);
}

function isPullNumberBatch(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 50 && value.every(isPullNumber);
}

function isReviewerRequest(value: unknown): value is Request {
  if (!record(value)) return false;
  const hasOnlyRequestFields = Object.keys(value).sort().join() === 'host,owner,pullNumbers,repo,type,version';
  const hasSupportedMessageType = value.version === 1 && value.type === 'getPullRequestReviewers';
  return hasOnlyRequestFields && hasSupportedMessageType && validHost(value.host) &&
    isRepositoryOwner(value.owner) && isRepositoryName(value.repo) && isPullNumberBatch(value.pullNumbers);
}

export function validateRequest(value: unknown, hosts: readonly string[]): Request | Failure {
  if (!isReviewerRequest(value)) return failure('INVALID_REQUEST');
  if (!hosts.includes(value.host)) return failure('UNSUPPORTED_HOST');
  return { version: 1, type: 'getPullRequestReviewers', host: value.host, owner: value.owner, repo: value.repo, pullNumbers: [...new Set(value.pullNumbers)] };
}

function isDisplayLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

function isUserReviewer(value: unknown): value is Extract<Reviewer, { kind: 'user' }> {
  return record(value) && value.kind === 'user' && isDisplayLabel(value.displayName) && isDisplayLabel(value.login) && value.login.length > 0;
}

function isTeamReviewer(value: unknown): value is Extract<Reviewer, { kind: 'team' }> {
  return record(value) && value.kind === 'team' && isDisplayLabel(value.displayName) && isDisplayLabel(value.slug) && value.slug.length > 0;
}

function isDisplayReview(value: unknown): value is Review {
  return record(value) && isDisplayLabel(value.login) && value.login.length > 0 && isDisplayLabel(value.displayName) && isReviewState(value.state);
}

function hasBoundedReviewCollections(value: unknown): value is { requestedReviewers: unknown[]; reviews: unknown[] } {
  return record(value) && Array.isArray(value.requestedReviewers) && Array.isArray(value.reviews) &&
    value.requestedReviewers.length <= 10000 && value.reviews.length <= 10000;
}

function isVersionOneMessage(value: unknown): value is Record<string, unknown> {
  return record(value) && value.version === 1;
}

function isResponseForRequest(value: Record<string, unknown>, request: Request): value is Record<string, unknown> & { pullRequests: Record<string, unknown> } {
  return value.type === 'pullRequestReviewers' && value.host === request.host && value.owner === request.owner &&
    value.repo === request.repo && record(value.pullRequests);
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(messages, value);
}

function sanitizeReviewer(value: unknown): Reviewer | undefined {
  if (isUserReviewer(value)) {
    return { kind: 'user', login: value.login, displayName: value.displayName };
  }
  if (isTeamReviewer(value)) {
    return { kind: 'team', slug: value.slug, displayName: value.displayName };
  }
}

function sanitizeReview(value: unknown): Review | undefined {
  if (!isDisplayReview(value)) return;
  return { login: value.login, displayName: value.displayName, state: value.state as Review['state'] };
}

function sanitizePull(value: unknown): Pull | undefined {
  if (!hasBoundedReviewCollections(value)) return;
  const requestedReviewers: Reviewer[] = [];
  const reviews: Review[] = [];
  for (const entry of value.requestedReviewers) {
    const reviewer = sanitizeReviewer(entry);
    if (!reviewer) return;
    requestedReviewers.push(reviewer);
  }
  for (const entry of value.reviews) {
    const review = sanitizeReview(entry);
    if (!review) return;
    reviews.push(review);
  }
  return { requestedReviewers, reviews };
}

// Reconstruct display data at the worker boundary; never forward arbitrary native output.
export function sanitizeResponse(value: unknown, request: Request): Response {
  if (!isVersionOneMessage(value)) return failure('TEMPORARY_FAILURE');
  if (value.type === 'error') return isErrorCode(value.code) ? failure(value.code) : failure('TEMPORARY_FAILURE');
  if (!isResponseForRequest(value, request)) return failure('TEMPORARY_FAILURE');
  const pullRequests: Record<string, Pull> = {};
  for (const number of request.pullNumbers) {
    const pull = sanitizePull(value.pullRequests[number]);
    if (!pull) return failure('TEMPORARY_FAILURE');
    pullRequests[number] = pull;
  }
  return { version: 1, type: 'pullRequestReviewers', host: request.host, owner: request.owner, repo: request.repo, pullRequests };
}
