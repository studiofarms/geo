// Always creates a disposable cluster. Never connects to DATABASE_URL/PGDATABASE.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { migrationScript, psql } from './database.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = await mkdtemp(join(tmpdir(), 'gocoach-db-test-'));
const cluster = join(runtime, 'data');
// macOS has a short Unix socket path limit; keep the socket directory short.
const socket = await mkdtemp('/tmp/gc-pg-');
const executable = name => process.env.PG_BIN ? resolve(process.env.PG_BIN, name) : name;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG') && key !== 'DATABASE_URL'));
Object.assign(env, { PGHOST: socket, PGPORT: '55439', PGDATABASE: 'postgres', PGUSER: userInfo().username,
  PG_BIN: process.env.PG_BIN || '', GOCOACH_DB_TEST: 'isolated-cluster' });

function run(command, args, stream = false) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: stream ? 'inherit' : ['ignore','pipe','pipe'] });
    let output = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveResult(output) : reject(new Error(`${command} exited ${code}: ${output}`)));
  });
}

let started = false;
try {
  await mkdir(cluster, { mode: 0o700 });
  await run(executable('initdb'), ['-D', cluster, '-A', 'trust', '--no-locale', '--encoding=UTF8']);
  await run(executable('pg_ctl'), ['-D', cluster, '-l', join(runtime, 'postgres.log'), '-o', `-k ${socket} -h '' -p 55439`, '-w', 'start']);
  started = true;
  const sql = await migrationScript();
  await psql(sql, { env });
  await psql(sql, { env });
  console.log('Fresh migration and repeat migration succeeded. Running isolated database tests.');
  await run(process.execPath, ['--test', 'tests/database/schema.test.mjs','tests/database/runtime.test.mjs','tests/database/calendly.test.mjs','tests/database/zoom.test.mjs'], true);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (started) {
    try { await run(executable('pg_ctl'), ['-D', cluster, '-m', 'fast', '-w', 'stop']); }
    catch (error) { console.error(error.message); process.exitCode = 1; started = false; }
  }
  // If shutdown failed, preserve the cluster for diagnosis rather than remove it.
  if (!started && process.exitCode) console.error(`Database test artifacts: ${runtime}`);
  else { await rm(runtime, { recursive: true, force: true }); await rm(socket, { recursive: true, force: true }); }
}
