import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const directory = process.env.DATA_DIR || fileURLToPath(new URL('../data/inquiries', import.meta.url));
const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const inquiries = await Promise.all(files.filter(name => /^[a-f\d-]+\.json$/i.test(name)).map(async name => JSON.parse(await readFile(join(directory, name), 'utf8'))));
console.log(JSON.stringify(inquiries.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)), null, 2));
