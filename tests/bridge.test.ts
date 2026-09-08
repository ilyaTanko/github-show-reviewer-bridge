import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir, endianness } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { failure, validateRequest, sanitizeResponse } from '../src/protocol.ts';
import type { Request } from '../src/protocol.ts';
import { fetchReviewers } from '../src/native/reviewers.ts';
import { classifyError, minimalEnvironment } from '../src/native/github-cli.ts';

const request: Request = { version: 1, type: 'getPullRequestReviewers', host: 'github.example.internal', owner: 'platform', repo: 'frontend', pullNumbers: [1, 2] };
const hosts = [request.host, 'git.other.internal'];
const page = (nodes: unknown[], next: string | null = null) => ({ nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } });
const review = (login: string, state: string, submittedAt: string) => ({ author: { login }, state, submittedAt });
const empty = { requestedReviewers: [], reviews: [] };
const success = (r: Request) => ({ version: 1, type: 'pullRequestReviewers', host: r.host, owner: r.owner, repo: r.repo, pullRequests: Object.fromEntries(r.pullNumbers.map(n => [n, empty])) });

test('request boundaries reject injection, unknown fields, hosts and invalid batch sizes', () => {
  for (const patch of [
    { host: 'https://github.example.internal' }, { host: 'github.example.internal:443' }, { host: 'github.example.internal/path' },
    { host: 'github.example.internal\n' }, { host: '127.0.0.1' }, { owner: 'x;echo' }, { repo: '..' }, { repo: 'x$(id)' },
    { query: 'mutation{}' }, { version: 2 }, { type: 'exec' }, { pullNumbers: [] }, { pullNumbers: [0] },
    { pullNumbers: [1.1] }, { pullNumbers: [Number.MAX_SAFE_INTEGER + 1] }, { pullNumbers: Array(51).fill(1) },
  ]) assert.equal(validateRequest({ ...request, ...patch }, hosts).type, 'error');
  assert.deepEqual(validateRequest({ ...request, host: 'unknown.internal' }, hosts), failure('UNSUPPORTED_HOST'));
  assert.deepEqual(validateRequest({ ...request, pullNumbers: [1, 1, 2] }, hosts), request);
  assert.equal(validateRequest({ ...request, host: hosts[1] }, hosts).type, request.type);
  assert.equal(validateRequest({ ...request, pullNumbers: Array.from({ length: 50 }, (_, i) => i + 1) }, hosts).type, request.type);
});

test('GraphQL batching, pagination, latest non-pending state, teams and bots', async () => {
  let calls = 0;
  const result = await fetchReviewers(request, async query => {
    assert.match(query, /author \{ login \}/);
    assert.match(query, /^query\(\$owner:String!,\$repo:String!\)/);
    assert.doesNotMatch(query, /mutation|token|email/);
    calls++;
    if (calls === 1) {
      assert.match(query, /p1: pullRequest\(number:1\)/); assert.match(query, /p2: pullRequest\(number:2\)/);
      return { data: { repository: {
        p1: { author: { login: 'pr-author' }, reviewRequests: page([{ requestedReviewer: { __typename: 'Team', slug: 'frontend', teamName: 'Frontend' } }], 'teams-next'), reviews: page([review('pr-author', 'COMMENTED', '2026-01-01T00:00:00Z'), review('bob', 'APPROVED', '2026-01-01T00:00:00Z'), review('bot[bot]', 'COMMENTED', '2026-01-01T00:00:00Z')], 'reviews-next') },
        p2: { reviewRequests: page([]), reviews: page([]) },
      } } };
    }
    assert.equal(calls, 2); assert.doesNotMatch(query, /p2:/); assert.match(query, /after:"teams-next"/);
    return { data: { repository: { p1: {
      author: { login: 'pr-author' },
      reviewRequests: page([{ requestedReviewer: { __typename: 'User', login: 'alice', userName: 'Alice' } }]),
      reviews: page([review('PR-Author', 'COMMENTED', '2026-03-01T00:00:00Z'), review('bob', 'CHANGES_REQUESTED', '2026-02-01T00:00:00Z'), review('bob', 'COMMENTED', '2025-01-01T00:00:00Z'), review('bob', 'PENDING', '')]),
    } } } };
  });
  assert.equal(result.type, 'pullRequestReviewers');
  if (result.type !== 'pullRequestReviewers') return;
  assert.equal(calls, 2);
  assert.deepEqual(result.pullRequests[1].requestedReviewers, [{ kind: 'team', slug: 'frontend', displayName: 'Frontend' }, { kind: 'user', login: 'alice', displayName: 'Alice' }]);
  assert.deepEqual(result.pullRequests[1].reviews.map(r => [r.login, r.state]), [['bob', 'CHANGES_REQUESTED'], ['bot[bot]', 'COMMENTED']]);
  assert.deepEqual(result.pullRequests[2], empty);
});

test('errors and display boundary never return raw output or extra metadata', async () => {
  for (const [text, code] of [['HTTP 401 secret', 'AUTH_REQUIRED'], ['HTTP 403 secret', 'ACCESS_DENIED'], ['HTTP 404 secret', 'NOT_FOUND'], ['RATE_LIMITED secret', 'RATE_LIMITED'], ['network secret', 'TEMPORARY_FAILURE']]) assert.equal(classifyError(text), code);
  assert.deepEqual(await fetchReviewers(request, async () => { throw new Error('secret'); }), failure('INTERNAL_ERROR'));
  assert.deepEqual(await fetchReviewers(request, async () => ({ errors: [{ type: 'FORBIDDEN', message: 'secret' }] })), failure('ACCESS_DENIED'));
  assert.deepEqual(await fetchReviewers(request, async () => ({ data: { repository: null } })), failure('NOT_FOUND'));
  assert.deepEqual(sanitizeResponse({ ...failure('AUTH_REQUIRED'), message: 'secret', stderr: 'secret' }, request), failure('AUTH_REQUIRED'));
  assert.deepEqual(sanitizeResponse({ ...success(request), token: 'secret' }, request), success(request));
  assert.equal(sanitizeResponse(success({ ...request, host: hosts[1] }), request).type, 'error');
  assert.equal(sanitizeResponse({ ...success(request), pullRequests: {} }, request).type, 'error');
  assert.ok(!('GITHUB_TOKEN' in minimalEnvironment())); assert.ok(!('GH_TOKEN' in minimalEnvironment())); assert.ok(!('NODE_OPTIONS' in minimalEnvironment()));
});

test('worker validates origins, shares overlapping in-flight requests and caches successes', async () => {
  const source = await readFile('dist/extension/background.js', 'utf8');
  let listener: (r: unknown, sender: unknown, reply: (v: unknown) => void) => boolean;
  let nativeCalls = 0;
  let resolveNative: (v: unknown) => void;
  let tabUrl = `https://${request.host}/${request.owner}/${request.repo}/pulls`;
  const chrome = {
    tabs: { get: async (id: number) => { assert.equal(id, 1); return { url: tabUrl }; } },
    runtime: {
      id: 'a'.repeat(32), getManifest: () => ({ host_permissions: hosts.map(h => `https://${h}/*`) }),
      onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      sendNativeMessage: () => { nativeCalls++; return new Promise(resolve => { resolveNative = resolve; }); },
    }, storage: { sync: { remove: async () => {} }, local: { remove: async () => {} } },
  };
  runInNewContext(source, { chrome, URL, setTimeout, clearTimeout });
  const sender = { id: chrome.runtime.id, frameId: 0, tab: { id: 1 }, url: `https://${request.host}/${request.owner}/${request.repo}/pulls` };
  const send = (r: unknown, s: unknown = sender) => new Promise<any>(resolve => listener(r, s, resolve));
  assert.equal((await send(request, { ...sender, url: 'https://evil.example/platform/frontend/pulls' })).code, 'INVALID_REQUEST');
  assert.equal((await send(request, { ...sender, frameId: 1 })).code, 'INVALID_REQUEST');
  assert.equal((await send({ ...request, query: 'secret' })).code, 'INVALID_REQUEST');
  assert.equal(nativeCalls, 0);
  const first = send(request); const second = send({ ...request, pullNumbers: [2] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nativeCalls, 1); resolveNative!(success(request));
  assert.equal((await first).type, 'pullRequestReviewers'); assert.equal((await second).type, 'pullRequestReviewers');
  assert.equal((await send(request)).type, 'pullRequestReviewers'); assert.equal(nativeCalls, 1);
  // Chrome keeps sender.url at the initial Code page after navigating to Pull requests.
  assert.equal((await send(request, { ...sender, url: `https://${request.host}/${request.owner}/${request.repo}` })).type, 'pullRequestReviewers');
  for (const url of [`https://${request.host}/${request.owner}/other/pulls`, `https://${request.host}/${request.owner}/${request.repo}`, 'https://evil.example/platform/frontend/pulls', `http://${request.host}/platform/frontend/pulls`]) {
    tabUrl = url;
    assert.equal((await send(request)).code, 'INVALID_REQUEST');
  }
  assert.equal(nativeCalls, 1);
});

function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4);
  if (endianness() === 'LE') header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
test('packaged native host enforces caller, framing, allowlist, missing gh and sanitized responses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reviewer-bridge-test-'));
  const origin = `chrome-extension://${'a'.repeat(32)}/`;
  try {
    await copyFile('dist/native-host/host.cjs', join(dir, 'host.cjs'));
    await writeFile(join(dir, 'config.json'), JSON.stringify({ hosts, origin, ghPath: join(dir, 'missing-gh') }));
    async function invoke(input: Buffer, caller = origin): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(dir, 'host.cjs'), caller], { stdio: ['pipe', 'pipe', 'pipe'] });
        const output: Buffer[] = []; const errors: Buffer[] = [];
        const timeout = setTimeout(() => { child.kill(); reject(new Error('native host stalled')); }, 20000);
        child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk)); child.stdin.on('error', () => {});
        child.on('error', reject);
        child.on('close', () => { clearTimeout(timeout); assert.equal(Buffer.concat(errors).length, 0); resolve(Buffer.concat(output)); });
        // Fragment both the length prefix and payload to exercise stream parsing.
        child.stdin.write(input.subarray(0, 2)); setTimeout(() => child.stdin.end(input.subarray(2)), 10);
      });
    }
    const decode = (b: Buffer) => {
      const length = endianness() === 'LE' ? b.readUInt32LE() : b.readUInt32BE();
      assert.equal(length, b.length - 4); return JSON.parse(b.subarray(4).toString());
    };
    assert.equal((await invoke(frame(request), `chrome-extension://${'b'.repeat(32)}/`)).length, 0);
    assert.deepEqual(decode(await invoke(frame(request))), failure('GH_NOT_FOUND'));
    assert.deepEqual(decode(await invoke(frame({ ...request, host: 'evil.example' }))), failure('UNSUPPORTED_HOST'));
    assert.deepEqual(decode(await invoke(frame({ ...request, command: 'echo secret' }))), failure('INVALID_REQUEST'));
    assert.deepEqual(decode(await invoke(Buffer.from([255, 255, 255, 255]))), failure('INVALID_REQUEST'));
    assert.deepEqual(decode(await invoke(frame(request).subarray(0, 8))), failure('INVALID_REQUEST'));
    if (process.platform !== 'win32') {
      const fakeGh = join(dir, 'fake-gh');
      await writeFile(fakeGh, `#!${process.execPath}
if (process.argv[2] === '--version') { console.log('gh version test'); process.exit(0); }
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['api','graphql','--hostname','${request.host}','--input','-'])) process.exit(2);
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.NODE_OPTIONS) process.exit(3);
let input = ''; process.stdin.on('data', b => input += b);
process.stdin.on('end', () => {
  const body = JSON.parse(input);
  if (body.variables.owner !== 'platform' || !body.query.startsWith('query(')) process.exit(4);
  const page = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  console.log(JSON.stringify({ data: { repository: { p1: { reviewRequests: page, reviews: page }, p2: { reviewRequests: page, reviews: page } } }, secret: 'not-for-browser' }));
});
`, { mode: 0o700 });
      await writeFile(join(dir, 'config.json'), JSON.stringify({ hosts, origin, ghPath: fakeGh }));
      assert.deepEqual(decode(await invoke(frame(request))), success(request));
      // Install into an isolated home; never change the user's actual Chrome registration.
      const build = JSON.parse(await readFile('dist/native-host/hosts.json', 'utf8'));
      const mode = build.development ? '--development' : '--production';
      const output = execFileSync(process.execPath, ['dist/native-host/install.cjs', 'a'.repeat(32), mode, fakeGh], { encoding: 'utf8', env: { ...process.env, HOME: dir } });
      assert.match(output, /gh version test/);
      const name = 'com.github_show_reviewer.bridge' + (build.development ? '.development' : '');
      const registration = process.platform === 'darwin' ? join(dir, 'Library/Application Support/Google/Chrome/NativeMessagingHosts') : join(dir, '.config/google-chrome/NativeMessagingHosts');
      const manifest = JSON.parse(await readFile(join(registration, name + '.json'), 'utf8'));
      assert.deepEqual(manifest.allowed_origins, [origin]);
      assert.equal(manifest.name, name);
      const installed = execFileSync(manifest.path, [origin], { input: frame({ ...request, host: build.hosts[0], pullNumbers: [] }) });
      assert.deepEqual(decode(installed), failure('INVALID_REQUEST'));
    }

  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('pagination advances each connection independently and rejects a repeated cursor', async () => {
  const single = { ...request, pullNumbers: [1] };
  let calls = 0;
  const result = await fetchReviewers(single, async query => {
    calls++;
    if (calls === 1) return { data: { repository: { p1: { reviewRequests: page([]), reviews: page([], 'next') } } } };
    assert.doesNotMatch(query, /reviewRequests\(/);
    assert.match(query, /reviews\(first:100,after:"next"\)/);
    return { data: { repository: { p1: { reviews: page([], 'next') } } } };
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, failure('TEMPORARY_FAILURE'));
});

test('display sanitization rejects invalid reviewers and strips nested metadata', () => {
  const responseWithPull = (pull: unknown) => ({ ...success(request), pullRequests: { 1: pull, 2: empty } });
  for (const pull of [
    { requestedReviewers: [{ kind: 'user', login: '', displayName: 'Alice' }], reviews: [] },
    { requestedReviewers: [{ kind: 'team', slug: 'team', displayName: 'bad\nname' }], reviews: [] },
    { requestedReviewers: [], reviews: [{ login: 'alice', displayName: 'Alice', state: 'PENDING' }] },
    { requestedReviewers: [], reviews: [{ login: 'alice', displayName: 'x'.repeat(257), state: 'APPROVED' }] },
  ]) assert.deepEqual(sanitizeResponse(responseWithPull(pull), request), failure('TEMPORARY_FAILURE'));
  const pull = {
    requestedReviewers: [{ kind: 'user', login: 'alice', displayName: 'Alice' }],
    reviews: [{ login: 'bob', displayName: 'Bob', state: 'COMMENTED' }],
  };
  const extraMetadata = {
    requestedReviewers: pull.requestedReviewers.map(reviewer => ({ ...reviewer, secret: 'hidden' })),
    reviews: pull.reviews.map(review => ({ ...review, secret: 'hidden' })),
  };
  assert.deepEqual(sanitizeResponse(responseWithPull(extraMetadata), request), responseWithPull(pull));
});

test('review decisions survive comments across pages and newer decisions replace older ones', async () => {
  for (const [states, expected] of [
    [['CHANGES_REQUESTED', 'COMMENTED'], 'CHANGES_REQUESTED'],
    [['APPROVED', 'COMMENTED'], 'APPROVED'],
    [['CHANGES_REQUESTED', 'APPROVED', 'COMMENTED'], 'APPROVED'],
    [['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'], 'CHANGES_REQUESTED'],
    [['DISMISSED', 'COMMENTED'], 'COMMENTED'],
  ] as [string[], string][]) {
    for (const reverse of [false, true]) {
      const nodes = states.map((state, index) => review('bot[bot]', state, `2026-01-0${index + 1}T00:00:00Z`));
      if (reverse) nodes.reverse();
      let index = 0;
      const result = await fetchReviewers({ ...request, pullNumbers: [1] }, async () => ({ data: { repository: { p1: {
        reviewRequests: page([]), reviews: page([nodes[index++]], index < nodes.length ? `page-${index}` : null),
      } } } }));
      assert.equal(result.type, 'pullRequestReviewers');
      if (result.type === 'pullRequestReviewers') assert.equal(result.pullRequests[1].reviews[0].state, expected);
    }
  }
});
