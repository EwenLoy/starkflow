import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const entry of ['index.html', 'favicon.svg', '.nojekyll', 'src', 'vendor']) {
  await cp(join(root, entry), join(dist, entry), { recursive: true });
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
