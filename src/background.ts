import { failure, sanitizeResponse, validateRequest } from './protocol.ts';
import type { Request, Response, Pull } from './protocol.ts';

declare const BRIDGE_HOST_NAME: string;
const hosts = (chrome.runtime.getManifest().host_permissions as string[]).map(pattern => new URL(pattern).hostname);
const cache = new Map<string, { expires: number; pull: Pull }>();
const pending = new Map<string, Promise<Response>>();
const pullCacheKey = (request: Request, number: number) => `${request.host}/${request.owner}/${request.repo}/${number}`;
function removeExpiredCacheEntries() {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
}

async function fetchAndCacheBatch(batch: Request): Promise<Response> {
  try {
    const response = sanitizeResponse(await chrome.runtime.sendNativeMessage(BRIDGE_HOST_NAME, batch), batch);
    if (response.type === 'pullRequestReviewers') {
      for (const number of batch.pullNumbers) {
        cache.set(pullCacheKey(batch, number), { expires: Date.now() + 45000, pull: response.pullRequests[number] });
      }
      // ponytail: 2000-entry session cache; use LRU only if this bound causes measurable misses.
      while (cache.size > 2000) cache.delete(cache.keys().next().value!);
    }
    return response;
  } catch { return failure('TEMPORARY_FAILURE'); }
  finally { for (const number of batch.pullNumbers) pending.delete(pullCacheKey(batch, number)); }
}

async function getReviewers(request: Request): Promise<Response> {
  removeExpiredCacheEntries();
  const uncachedNumbers = request.pullNumbers.filter(number => !cache.has(pullCacheKey(request, number)));
  const jobs = new Set<Promise<Response>>();
  const unrequestedNumbers = uncachedNumbers.filter(number => {
    const job = pending.get(pullCacheKey(request, number));
    if (job) jobs.add(job);
    return !job;
  });
  if (unrequestedNumbers.length) {
    const batch = { ...request, pullNumbers: unrequestedNumbers };
    const job = fetchAndCacheBatch(batch);
    for (const number of unrequestedNumbers) pending.set(pullCacheKey(request, number), job);
    jobs.add(job);
  }
  const pullRequests: Record<string, Pull> = {};
  for (const number of request.pullNumbers) {
    const entry = cache.get(pullCacheKey(request, number));
    if (entry) pullRequests[number] = entry.pull;
  }
  for (const response of await Promise.all(jobs)) {
    if (response.type === 'error') return response;
    for (const number of request.pullNumbers) if (response.pullRequests[number]) pullRequests[number] = response.pullRequests[number];
  }
  return sanitizeResponse({ version: 1, type: 'pullRequestReviewers', host: request.host, owner: request.owner, repo: request.repo, pullRequests }, request);
}

function isAllowedHostUrl(url: URL, request: Request): boolean {
  return url.protocol === 'https:' && !url.port && url.hostname === request.host;
}

function isExtensionTopFrame(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.frameId === 0 && sender.tab?.id !== undefined;
}

function isRequestedPullList(url: URL, request: Request): boolean {
  const pullsPath = `/${request.owner}/${request.repo}/pulls`;
  return isAllowedHostUrl(url, request) && [pullsPath, `${pullsPath}/`].includes(url.pathname);
}

function isTrustedSender(sender: chrome.runtime.MessageSender, request: Request): boolean {
  if (!isExtensionTopFrame(sender)) return false;
  try { return isAllowedHostUrl(new URL(sender.url ?? ''), request); }
  catch { return false; }
}

async function getReviewersForCurrentTab(tabId: number, request: Request): Promise<Response> {
  // sender.url retains the document's original URL after GitHub's SPA navigation.
  // Check the current top-level tab URL without trusting a page-supplied URL.
  const tab = await chrome.tabs.get(tabId);
  const url = new URL(tab.url ?? '');
  if (!isRequestedPullList(url, request)) return failure('INVALID_REQUEST');
  return getReviewers(request);
}

chrome.runtime.onMessage.addListener((value: unknown, sender, reply) => {
  const request = validateRequest(value, hosts);
  if (request.type === 'error') { reply(request); return false; }
  if (!isTrustedSender(sender, request)) { reply(failure('INVALID_REQUEST')); return false; }
  void getReviewersForCurrentTab(sender.tab!.id!, request).then(reply, () => reply(failure('INVALID_REQUEST')));
  return true;
});

// Remove credentials left by the previous version without reading them.
async function removeLegacyToken() {
  await Promise.all([chrome.storage.sync.remove('githubToken'), chrome.storage.local.remove('githubToken')]);
}
chrome.runtime.onInstalled.addListener(() => { void removeLegacyToken().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void removeLegacyToken().catch(() => {}); });
void removeLegacyToken().catch(() => {});
