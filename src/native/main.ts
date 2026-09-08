import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { failure, record, isHostAllowlist, validateRequest } from '../protocol.ts';
import type { Response } from '../protocol.ts';
import { fetchReviewers } from './reviewers.ts';
import { ghRunner } from './github-cli.ts';
import { respondToNativeMessage, send } from './native-messaging.ts';

type HostConfig = { origin: string; ghPath: string; hosts: string[] };

function isAuthorizedConfig(config: unknown, caller: string | undefined): config is HostConfig {
  if (!record(config)) return false;
  if (typeof config.origin !== 'string') return false;
  const isExtensionOrigin = /^chrome-extension:\/\/[a-p]{32}\/$/.test(config.origin);
  const hasAllowedHosts = isHostAllowlist(config.hosts);
  return isExtensionOrigin && caller === config.origin && typeof config.ghPath === 'string' && hasAllowedHosts;
}

async function handleRequestBody(body: Buffer, config: HostConfig): Promise<Response> {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    return failure('INVALID_REQUEST');
  }
  const request = validateRequest(value, config.hosts);
  return request.type === 'error' ? request : fetchReviewers(request, ghRunner(config.ghPath));
}

async function main() {
  const config: unknown = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));
  if (!isAuthorizedConfig(config, process.argv[2])) return;
  await respondToNativeMessage(body => handleRequestBody(body, config));
}

void main().catch(() => {
  send(failure('INTERNAL_ERROR'));
  process.stdin.destroy();
});
