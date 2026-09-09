import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionEnvironment } from '../scripts/database.mjs';

test('a Neon connection URI becomes the PG* variables libpq reads', () => {
  const env = connectionEnvironment({
    DATABASE_URL: 'postgresql://gocoach_owner:s3cr3t@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  });
  assert.equal(env.PGHOST, 'ep-cool-name-123.us-east-2.aws.neon.tech');
  assert.equal(env.PGUSER, 'gocoach_owner');
  assert.equal(env.PGPASSWORD, 's3cr3t');
  assert.equal(env.PGDATABASE, 'neondb');
  assert.equal(env.PGSSLMODE, 'require');
  assert.equal(env.PGCHANNELBINDING, 'require');
  // The URI must never remain in PGDATABASE: libpq would read it as a database name.
  assert.ok(!env.PGDATABASE.includes('://'));
});

test('percent-encoded credentials are decoded, and the port is carried across', () => {
  const env = connectionEnvironment({ DATABASE_URL: 'postgres://user%40corp:p%40ss%2Fword@db.example:6543/go%20coach' });
  assert.equal(env.PGUSER, 'user@corp');
  assert.equal(env.PGPASSWORD, 'p@ss/word');
  assert.equal(env.PGPORT, '6543');
  assert.equal(env.PGDATABASE, 'go coach');
});

test('a host parameter carrying a Unix socket directory outranks the authority', () => {
  const env = connectionEnvironment({ DATABASE_URL: 'postgresql://someone@localhost/gocoach?host=/var/run/postgresql' });
  assert.equal(env.PGHOST, '/var/run/postgresql');
  assert.equal(env.PGDATABASE, 'gocoach');
});

test('an IPv6 literal loses its brackets, which libpq does not accept', () => {
  const env = connectionEnvironment({ DATABASE_URL: 'postgresql://someone@[::1]:5432/gocoach' });
  assert.equal(env.PGHOST, '::1');
  assert.equal(env.PGPORT, '5432');
});

test('without DATABASE_URL the existing PG* variables are left alone', () => {
  const env = connectionEnvironment({ PGHOST: '127.0.0.1', PGDATABASE: 'gocoach', PGUSER: 'coach' });
  assert.equal(env.PGHOST, '127.0.0.1');
  assert.equal(env.PGDATABASE, 'gocoach');
  assert.equal(env.PGUSER, 'coach');
});

test('the URI wins over a conflicting PGDATABASE but unrelated variables survive', () => {
  const env = connectionEnvironment({ DATABASE_URL: 'postgresql://db.example/fromurl', PGDATABASE: 'stale', PG_BIN: '/usr/lib/postgresql/16/bin' });
  assert.equal(env.PGDATABASE, 'fromurl');
  assert.equal(env.PG_BIN, '/usr/lib/postgresql/16/bin');
});

test('a malformed or non-PostgreSQL URI is refused before anything connects', () => {
  assert.throws(() => connectionEnvironment({ DATABASE_URL: 'not a url' }), /valid connection URI/);
  assert.throws(() => connectionEnvironment({ DATABASE_URL: 'mysql://user@host/db' }), /postgresql:\/\/ scheme/);
});
