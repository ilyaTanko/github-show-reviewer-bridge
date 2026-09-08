import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { HOST_NAME, isHostAllowlist } from '../src/protocol.ts';

const config = JSON.parse(await readFile('bridge.config.json', 'utf8')) as { hosts: unknown };
if (!isHostAllowlist(config.hosts)) throw new Error('bridge.config.json: specify explicit lowercase GitHub hostnames.');
const hosts = [...new Set(config.hosts)] as string[];
const development = process.env.BRIDGE_DEVELOPMENT === '1';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/extension', { recursive: true });
await mkdir('dist/native-host', { recursive: true });
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
if (development) manifest.name += ' (Development)';
manifest.host_permissions = hosts.map(host => `https://${host}/*`);
manifest.content_scripts[0].matches = manifest.host_permissions;
await writeFile('dist/extension/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
await writeFile('dist/native-host/hosts.json', JSON.stringify({ hosts, development }, null, 2) + '\n');
await build({ entryPoints: ['src/background.ts', 'src/content.ts'], bundle: true, outdir: 'dist/extension', platform: 'browser', format: 'iife', target: 'chrome120', legalComments: 'none', define: { BRIDGE_HOST_NAME: JSON.stringify(development ? `${HOST_NAME}.development` : HOST_NAME) } });
await build({ entryPoints: ['src/native/main.ts'], bundle: true, outfile: 'dist/native-host/host.cjs', platform: 'node', format: 'cjs', target: 'node22' });
await build({ entryPoints: ['scripts/install.ts'], bundle: true, outfile: 'dist/native-host/install.cjs', platform: 'node', format: 'cjs', target: 'node22' });
for (const file of ['style.css', 'icons']) await cp(file, `dist/extension/${file}`, { recursive: true });
for (const file of ['README.md', 'privacy-policy.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(file, `dist/${file}`);

await cp('licenses', 'dist/extension/licenses', { recursive: true });
await cp('THIRD_PARTY_NOTICES.md', 'dist/extension/THIRD_PARTY_NOTICES.md');
await cp('licenses', 'dist/licenses', { recursive: true });

await mkdir('dist/docs', { recursive: true });
await cp('docs/show_reviewer_list.png', 'dist/docs/show_reviewer_list.png');
