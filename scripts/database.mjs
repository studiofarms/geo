import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const migrationDirectory = new URL('../netlify/database/migrations/', import.meta.url);
const literal = value => `'${String(value).replaceAll("'", "''")}'`;

export async function migrationScript() {
  const names = (await readdir(migrationDirectory)).filter(name => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort();
  if (!names.length) throw new Error('No database migrations found.');
  const migrations = await Promise.all(names.map(async name => {
    const sql = await readFile(new URL(name, migrationDirectory), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  const manifest = migrations.map(m => `(${literal(m.name)},${literal(m.checksum)})`).join(',\n');
  return `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(7640260907001);
DO $version$ BEGIN
  IF current_setting('server_version_num')::integer < 150000 THEN
    RAISE EXCEPTION 'GoCoach requires PostgreSQL 15 or newer';
  END IF;
END $version$;
CREATE SCHEMA IF NOT EXISTS gocoach_meta;
REVOKE ALL ON SCHEMA gocoach_meta FROM PUBLIC;
CREATE TABLE IF NOT EXISTS gocoach_meta.schema_migrations (
  version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TEMP TABLE migration_manifest(version text PRIMARY KEY, checksum text NOT NULL) ON COMMIT DROP;
INSERT INTO migration_manifest VALUES ${manifest};
DO $checksums$ BEGIN
  IF EXISTS (SELECT 1 FROM gocoach_meta.schema_migrations a LEFT JOIN migration_manifest m USING(version)
    WHERE m.version IS NULL OR m.checksum<>a.checksum) THEN
    RAISE EXCEPTION 'Applied migration is missing or has changed; restore it and add a new migration';
  END IF;
  IF EXISTS (SELECT 1 FROM migration_manifest m WHERE m.version<(SELECT max(version) FROM gocoach_meta.schema_migrations)
    AND NOT EXISTS (SELECT 1 FROM gocoach_meta.schema_migrations a WHERE a.version=m.version)) THEN
    RAISE EXCEPTION 'Migration history contains a gap';
  END IF;
END $checksums$;
${migrations.map(m => `SELECT NOT EXISTS (SELECT 1 FROM gocoach_meta.schema_migrations WHERE version=${literal(m.name)}) AS apply_migration \\gset
\\if :apply_migration
\\echo Applying ${m.name}
${m.sql}
INSERT INTO gocoach_meta.schema_migrations(version,checksum) VALUES (${literal(m.name)},${literal(m.checksum)});
\\endif`).join('\n')}
COMMIT;
SELECT version,applied_at FROM gocoach_meta.schema_migrations ORDER BY version;
`;
}

// libpq connection parameters that have an environment variable equivalent.
const connectionParameters = {
  sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY',
  channel_binding: 'PGCHANNELBINDING', application_name: 'PGAPPNAME', options: 'PGOPTIONS',
  connect_timeout: 'PGCONNECT_TIMEOUT', target_session_attrs: 'PGTARGETSESSIONATTRS',
};

/** Translate DATABASE_URL into the PG* variables libpq reads.
 * libpq only expands a connection URI supplied as the dbname argument, not one
 * inherited from PGDATABASE, so a URI left in PGDATABASE is taken literally as a
 * database name. Passing it in argv would expand it but would also expose the
 * password in `ps` output, so it is translated here and every secret stays in
 * the environment. Values in the URI win over matching PG* variables already set.
 * @param {NodeJS.ProcessEnv} env @returns {NodeJS.ProcessEnv} */
export function connectionEnvironment(env) {
  const result = { ...env };
  if (!env.DATABASE_URL) return result;
  let url;
  try { url = new URL(env.DATABASE_URL); }
  catch { throw new Error('DATABASE_URL is not a valid connection URI. No database was changed.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use the postgresql:// scheme. No database was changed.');
  const set = (variable, value) => { if (value) result[variable] = value; };
  // A ?host= parameter carries a Unix socket directory and outranks the authority.
  set('PGHOST', url.searchParams.get('host') || decodeURIComponent(url.hostname).replace(/^\[|\]$/g, ''));
  set('PGPORT', url.port);
  set('PGUSER', url.username && decodeURIComponent(url.username));
  set('PGPASSWORD', url.password && decodeURIComponent(url.password));
  set('PGDATABASE', decodeURIComponent(url.pathname.replace(/^\//, '')));
  for (const [parameter, variable] of Object.entries(connectionParameters)) set(variable, url.searchParams.get(parameter));
  return result;
}

export function psql(sql, { env = process.env, args = [], onOutput } = {}) {
  const connectionEnv = connectionEnvironment(env);
  if (!connectionEnv.PGDATABASE) throw new Error('Set DATABASE_URL or PGDATABASE explicitly. No database was changed.');
  const executable = env.PSQL_BIN || (env.PG_BIN ? resolve(env.PG_BIN, 'psql') : 'psql');
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, ['-X', '--no-password', '--set=ON_ERROR_STOP=1', '--file=-', ...args], {
      env: connectionEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; onOutput?.(chunk.toString()); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', code => {
      if (code === 0) resolveResult(stdout);
      else reject(new Error(`PostgreSQL command failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(sql);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && args[0] !== '--print')) throw new Error('Usage: node scripts/database.mjs [--print]');
    const sql = await migrationScript();
    if (args[0] === '--print') process.stdout.write(sql);
    else process.stdout.write(await psql(sql));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
