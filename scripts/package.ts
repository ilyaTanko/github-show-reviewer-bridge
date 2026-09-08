import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
async function files(dir: string, prefix = ''): Promise<Record<string, Uint8Array>> {
  const result: Record<string, Uint8Array> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) Object.assign(result, await files(`${dir}/${entry.name}`, `${prefix}${entry.name}/`));
    else result[`${prefix}${entry.name}`] = await readFile(`${dir}/${entry.name}`);
  }
  return result;
}
await mkdir('release', { recursive: true });
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const { development } = JSON.parse(await readFile('dist/native-host/hosts.json', 'utf8'));
const path = `release/github-show-reviewer-bridge-${version}${development ? '-development' : ''}.zip`;
await writeFile(path, zipSync(await files('dist'), { level: 9 }));
console.log(path);
