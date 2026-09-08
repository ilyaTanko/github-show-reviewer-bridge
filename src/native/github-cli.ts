import { execFile } from 'node:child_process';
import { failure } from '../protocol.ts';
import type { ErrorCode, Request } from '../protocol.ts';

export function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  };
  for (const name of ['HOME', 'USERPROFILE', 'SystemRoot', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return env;
}
export function classifyError(text: string): ErrorCode {
  if (/rate.?limit|RATE_LIMITED|HTTP 429/i.test(text)) return 'RATE_LIMITED';
  if (/HTTP 401|bad credentials|authentication|gh auth login|not logged/i.test(text)) return 'AUTH_REQUIRED';
  if (/HTTP 403|FORBIDDEN|permission|access denied|resource not accessible/i.test(text)) return 'ACCESS_DENIED';
  if (/HTTP 404|NOT_FOUND|could not resolve to/i.test(text)) return 'NOT_FOUND';
  return 'TEMPORARY_FAILURE';
}
export type RunQuery = (query: string, request: Request, timeout: number) => Promise<unknown>;
export function ghRunner(ghPath: string): RunQuery {
  return (query, request, timeout) => new Promise((resolve, reject) => {
    const child = execFile(ghPath, ['api', 'graphql', '--hostname', request.host, '--input', '-'], {
      env: minimalEnvironment(), timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'GH_NOT_FOUND' : classifyError(stderr);
        reject(failure(code));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(failure('TEMPORARY_FAILURE'));
      }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ query, variables: { owner: request.owner, repo: request.repo } }));
  });
}
