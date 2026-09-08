import { readdir, readFile, mkdir, cp, rm, rename } from 'node:fs/promises';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'src');
const output = join(root, 'dist');
const staging = join(root, '.build-staging');
const extensions = new Set(['.html', '.css', '.js', '.svg', '.png', '.woff2', '.woff', '.ttf', '.txt']);
/** @param {string} directory @returns {Promise<string[]>} */
async function publicFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'server') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await publicFiles(path));
    else if (entry.isFile() && extensions.has(extname(path))) files.push(path);
  }
  return files;
}
const files = await publicFiles(source);
const publicPaths = new Set(files.map(path => '/' + path.slice(source.length + 1)));
for (const path of files) {
  if (path.endsWith('.js')) {
    execFileSync(process.execPath, ['--check', path]);
    const script = await readFile(path, 'utf8');
    for (const match of script.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) {
      const dependency = '/' + resolve(dirname(path), match[1]).slice(source.length + 1);
      if (!publicPaths.has(dependency)) throw new Error(`Missing module ${dependency} imported by ${path}`);
    }
  }
  if (!/\.(html|css)$/.test(path)) continue;
  const content = await readFile(path, 'utf8');
  for (const match of content.matchAll(/(?:href|src)="(\/[^"#?]*)(?:[?#][^"]*)?"|url\(["']?(\/[^)'"?]+)["']?\)/g)) {
    const resource = match[1] || match[2];
    if (resource !== '/' && !publicPaths.has(resource)) throw new Error(`Missing public asset ${resource} referenced by ${path}`);
  }
}
for (const required of ['index.html', 'portal.html', 'book.html', 'syllabus.html', 'inquiry-received.html', '404.html']) {
  if (!publicPaths.has('/' + required)) throw new Error(`Missing required page: ${required}`);
}
await rm(staging, { recursive: true, force: true });
await mkdir(staging);
for (const path of files) {
  const destination = join(staging, path.slice(source.length + 1));
  await mkdir(join(destination, '..'), { recursive: true });
  await cp(path, destination);
}
await rm(output, { recursive: true, force: true });
await rename(staging, output);
console.log(`Production build ready: ${files.length} public files in dist/.\nServer code and inquiry records are excluded.\nStart with: npm --prefix config start`);
