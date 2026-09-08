import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { id } from './core.mjs';
import { seed } from './seed.mjs';
/** Serialized, atomic single-process persistence. Files stay outside the public root. */
export class Store {
  /** @param {string} directory @param {boolean} demo */
  constructor(directory, demo = false) { this.directory = directory; this.demo = demo; this.queue = Promise.resolve(); this.loaded = null; }
  /** @returns {Promise<any>} */
  async load() {
    if (!this.loaded) this.loaded = (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try { return JSON.parse(await readFile(join(this.directory, 'workspace.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; const db = seed(this.demo); await this.write(db); return db; }
    })();
    return this.loaded;
  }
  /** @param {any} db @returns {Promise<void>} */
  async write(db) {
    const temporary = join(this.directory, `.${id()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(db)); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, join(this.directory, 'workspace.json')); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  /** @param {(db:any)=>any|Promise<any>} callback @param {boolean} mutate @returns {Promise<any>} */
  run(callback, mutate = false) {
    const pending = this.queue.then(async () => {
      const original = await this.load();
      const db = structuredClone(original);
      const result = await callback(db);
      if (mutate) { await this.write(db); this.loaded = Promise.resolve(db); }
      return result;
    });
    this.queue = pending.catch(() => {});
    return pending;
  }
}
