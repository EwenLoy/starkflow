import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

// Local overrides live in a git-ignored demo/chess/.env; CI passes the same
// name through the environment, so the working endpoint never reaches git.
async function readDotEnv() {
  try {
    const raw = await readFile(join(root, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] in process.env) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {
    /* no local overrides */
  }
}

await readDotEnv();

const wsUrl = (process.env.STARKFLOW_WS_URL || '').trim();
if (wsUrl && !/^wss?:\/\/\S+$/.test(wsUrl)) {
  throw new Error('STARKFLOW_WS_URL must look like wss://host/ws');
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const entry of ['index.html', 'favicon.svg', '.nojekyll', 'src', 'vendor']) {
  await cp(join(root, entry), join(dist, entry), { recursive: true });
}

if (wsUrl) {
  await writeFile(join(dist, 'src', 'env.js'), `export const WS_URL = ${JSON.stringify(wsUrl)};\n`);
}

async function walk(dir) {
  const { readdir } = await import('node:fs/promises');
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

const files = await walk(dist);
let bytes = 0;
for (const file of files) bytes += (await stat(file)).size;
console.log(`Built ${files.length} files into ${relative(process.cwd(), dist) || '.'}`);
console.log(`Total: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
