import { execFileSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { HOST_NAME, isHostAllowlist } from '../src/protocol.ts';
import { minimalEnvironment } from '../src/native/github-cli.ts';

function isInstallInvocation(id: string | undefined, mode: string, argumentCount: number): boolean {
  return typeof id === 'string' && /^[a-p]{32}$/.test(id) && ['--production', '--development'].includes(mode) && argumentCount <= 5;
}

function parseInstallArguments() {
  const [id, mode, suppliedGh] = process.argv.slice(2);
  if (!isInstallInvocation(id, mode, process.argv.length)) throw new Error('Usage: node install.cjs EXTENSION_ID --production|--development [absolute-gh-path]');
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error('Unsupported platform.');
  return { id, mode, suppliedGh };
}

function readConfiguredHosts(mode: string): string[] {
  const config = JSON.parse(readFileSync(join(__dirname, 'hosts.json'), 'utf8'));
  const hosts: unknown = config.hosts;
  if (config.development !== (mode === '--development')) throw new Error('Installation mode must match the build mode (BRIDGE_DEVELOPMENT=1 for development).');
  if (!isHostAllowlist(hosts)) throw new Error('Invalid host configuration.');
  return hosts;
}

function findGitHubCli(suppliedGh?: string): string {
  const candidates = suppliedGh ? [suppliedGh] : process.platform === 'win32'
    ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe')]
    : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
  const ghPath = candidates.find(path => {
    try { if (!isAbsolute(path)) return false; accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  if (!ghPath) throw new Error('GitHub CLI not found. Install from https://cli.github.com and rerun with its absolute path.');
  const executable = realpathSync(ghPath);
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096, env: minimalEnvironment() }).split('\n')[0];
  console.log(`GitHub CLI: ${executable} (${version})`);
  return executable;
}

function installationDirectory(mode: string): string {
  const base = process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? homedir(), 'GitHubShowReviewerBridge') : join(homedir(), '.local', 'share', 'github-show-reviewer-bridge');
  return join(base, mode === '--production' ? 'production' : 'development');
}

function writeLauncher(destination: string): string {
  let launcher: string;
  if (process.platform === 'win32') {
    launcher = join(destination, 'launch.cmd');
    // cmd expands percent signs even within quotes; refuse paths that cannot be quoted safely.
    if ([process.execPath, destination].some(p => /[%!\r\n"]/u.test(p))) throw new Error('Install Node and the bridge in paths without %, !, quotes or newlines.');
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${join(destination, 'host.cjs')}" "%~1"\r\n`);
  } else {
    launcher = join(destination, 'launch');
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(destination, 'host.cjs'))} "$@"\n`, { mode: 0o700 });
  }
  return launcher;
}

function registerNativeHost(mode: string, destination: string, launcher: string, origin: string): string {
  const name = mode === '--production' ? HOST_NAME : `${HOST_NAME}.development`;
  const registration = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts') : process.platform === 'linux' ? join(homedir(), '.config', 'google-chrome', 'NativeMessagingHosts') : destination;
  mkdirSync(registration, { recursive: true });
  const manifestPath = resolve(registration, `${name}.json`);
  writeFileSync(manifestPath, JSON.stringify({ name, description: 'Read-only GitHub reviewer bridge', path: launcher, type: 'stdio', allowed_origins: [origin] }, null, 2), { mode: 0o600 });
  if (process.platform === 'win32') execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'), ['ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${name}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'ignore' });
  return manifestPath;
}

function install() {
  const { id, mode, suppliedGh } = parseInstallArguments();
  const hosts = readConfiguredHosts(mode);
  const executable = findGitHubCli(suppliedGh);
  const destination = installationDirectory(mode);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  copyFileSync(join(__dirname, 'host.cjs'), join(destination, 'host.cjs'));
  const origin = `chrome-extension://${id}/`;
  writeFileSync(join(destination, 'config.json'), JSON.stringify({ hosts, ghPath: executable, origin }, null, 2), { mode: 0o600 });
  const launcher = writeLauncher(destination);
  const manifestPath = registerNativeHost(mode, destination, launcher, origin);
  console.log(`Installed: ${manifestPath}\nAllowed hosts: ${hosts.join(', ')}\nRestart the extension after installation.`);
}
try { install(); } catch (error) { console.error(error instanceof Error ? error.message : 'Installation failed.'); process.exitCode = 1; }
