import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server/http.mjs';
import { validateInquiry } from '../src/server/inquiries.mjs';
import { uuid } from '../src/random.js';

const source = fileURLToPath(new URL('../src', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'gocoach-test-'));
const servers = [];
after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  })));
  await rm(temporary, { recursive: true, force: true });
});
const valid = { name: 'Test Manager', email: 'test@example.com', organization: 'Example Organization', interest: 'sponsor', message: 'A test inquiry about a cohort.', consent: true };
/** @param {Record<string, unknown>} options */
async function fixture(options = {}) {
  const directory = join(temporary, randomUUID());
  const server = createApp({ root: source, dataDirectory: directory, ...options });
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (data = valid, headers = {}) => fetch(base + '/api/inquiries', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
  });
  return { base, post, directory };
}

test('homepage and every local asset respond with the correct content type', async () => {
  const { base } = await fixture();
  const checked = new Set();
  async function check(path) {
    if (checked.has(path)) return;
    checked.add(path);
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    const type = response.headers.get('content-type');
    const body = await response.text();
    if (!/html|css/.test(type)) return;
    for (const match of body.matchAll(/(?:href|src)="(\/[^"#?]*)(?:[?#][^"]*)?"|url\(["']?(\/[^)'"?]+)["']?\)/g)) {
      await check(match[1] || match[2]);
    }
  }
  await check('/');
  assert.ok(checked.size >= 15);
});

test('a valid inquiry is normalized, saved privately, and acknowledged honestly', async () => {
  const { post, directory } = await fixture();
  const response = await post({ ...valid, name: '  Test Manager  ', email: '  TEST@example.com  ' });
  assert.equal(response.status, 201);
  const receipt = await response.json();
  assert.match(receipt.reference, /^GC-[A-F0-9]{8}$/);
  assert.equal(receipt.delivery, 'local');
  assert.match(receipt.message, /No email has been sent/);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const saved = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
  assert.equal(saved.name, valid.name);
  assert.equal(saved.email, valid.email);
  assert.equal(saved.reference, receipt.reference);
  assert.ok(!Number.isNaN(Date.parse(saved.receivedAt)));
  assert.ok(!('website' in saved));
});

test('simultaneous retries save exactly one inquiry and return one reference', async () => {
  const { post, directory } = await fixture();
  const headers = { 'Idempotency-Key': randomUUID() };
  const responses = await Promise.all(Array.from({ length: 5 }, () => post(valid, headers)));
  assert.equal(responses.filter(response => response.status === 201).length, 1);
  assert.equal(responses.filter(response => response.status === 200).length, 4);
  const receipts = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(receipts.map(receipt => receipt.reference)).size, 1);
  assert.equal((await readdir(directory)).length, 1);
});

test('reusing a request key for different details returns a conflict', async () => {
  const { post } = await fixture();
  const headers = { 'Idempotency-Key': randomUUID() };
  assert.equal((await post(valid, headers)).status, 201);
  assert.equal((await post({ ...valid, message: 'Different details' }, headers)).status, 409);
});

test('malicious request IDs cannot control the storage path', async () => {
  const { post, directory } = await fixture();
  assert.equal((await post(valid, { 'Idempotency-Key': '../../outside' })).status, 400);
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});

test('required fields, email, consent, and inquiry type are validated on the server', async () => {
  const { post, directory } = await fixture();
  const response = await post({ ...valid, name: ' ', email: 'invalid', interest: 'payment', consent: false });
  assert.equal(response.status, 422);
  const result = await response.json();
  assert.deepEqual(Object.keys(result.fields).sort(), ['consent', 'email', 'interest', 'name']);
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});

test('optional fields can be empty and Unicode names are preserved', () => {
  const result = validateInquiry({ name: '李明 — María', email: 'person@example.com', interest: 'participant', consent: true });
  assert.equal(result.name, '李明 — María');
  assert.equal(result.message, '');
  assert.equal(result.organization, '');
});

test('field lengths and control characters are rejected', () => {
  for (const data of [{ message: 'x'.repeat(2001) }, { name: 'x'.repeat(101) }, { organization: 'x'.repeat(161) }, { name: 'Bad\u0000name' }]) {
    assert.throws(() => validateInquiry({ ...valid, ...data }), { status: 422 });
  }
});

test('the honeypot prevents a record from being saved', async () => {
  const { post, directory } = await fixture();
  assert.equal((await post({ ...valid, website: 'https://spam.example' })).status, 422);
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});

test('cross-origin submissions are refused before storing data', async () => {
  const { post, directory } = await fixture();
  assert.equal((await post(valid, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await post(valid, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});

test('same-origin submissions are accepted', async () => {
  const { post, base } = await fixture();
  assert.equal((await post(valid, { Origin: base })).status, 201);
});

test('development permits an explicit LAN origin and localhost while rejecting other hosts', async () => {
  const origin = 'http://192.0.2.10:4173';
  // Native HTTP preserves the Host override; fetch replaces it with its URL host.
  const status = (base, host, requestOrigin, body) => new Promise((resolve, reject) => {
    const request = httpRequest(base + (body ? '/api/inquiries' : '/api/health'), {
      method: body ? 'POST' : 'GET', headers: { Host: host, ...(requestOrigin ? { Origin: requestOrigin } : {}), 'Content-Type': 'application/json' },
    }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
  const { base } = await fixture({ development: true, publicOrigin: origin });
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal(await status(base, new URL(origin).host, origin, valid), 201);
  assert.equal(await status(base, new URL(origin).host, 'https://unrelated.example', valid), 403);
  assert.equal(await status(base, 'unrelated.example'), 403);
  const production = await fixture({ publicOrigin: origin });
  assert.equal((await fetch(production.base + '/api/health')).status, 403);
  assert.equal(await status(production.base, new URL(origin).host), 200);
});

test('request IDs work when local-network HTTP has no crypto.randomUUID', () => {
  const source = { getRandomValues: values => globalThis.crypto.getRandomValues(values) };
  const ids = Array.from({ length: 100 }, () => uuid(source));
  assert.equal(new Set(ids).size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('rate limiting returns a retry interval', async () => {
  const { post } = await fixture({ rateLimit: 2 });
  assert.equal((await post()).status, 201);
  assert.equal((await post()).status, 201);
  const response = await post();
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});

test('oversized and malformed bodies fail without exposing internals', async () => {
  const { base, post } = await fixture();
  assert.equal((await post({ ...valid, message: 'x'.repeat(20000) })).status, 413);
  const response = await fetch(base + '/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
  assert.ok(!('stack' in await response.json()));
  for (const body of [null, [], 'text']) assert.equal((await post(body)).status, 400);
});

test('plain form submission works without JavaScript', async () => {
  const { base, directory } = await fixture();
  const response = await fetch(base + '/api/inquiries', {
    method: 'POST', body: new URLSearchParams({ ...valid, consent: 'on' }), redirect: 'manual',
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/inquiry-received.html');
  assert.equal((await readdir(directory)).length, 1);
  assert.match(await (await fetch(base + response.headers.get('location'))).text(), /No email has been sent/);
});

test('private records, source modules, hidden files, and encoded traversal are inaccessible', async () => {
  const { base } = await fixture();
  for (const path of ['/data/inquiries/example.json', '/server/http.mjs', '/.env', '/%2eenv', '/%2e%2e%2fconfig/package.json', '/assets%5c..%5c.env', '/%00']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test('static symlinks cannot escape the public directory', async () => {
  const directory = await mkdtemp(join(temporary, 'public-'));
  await symlink(join(source, 'index.html'), join(directory, 'escape.html'));
  const { base } = await fixture({ root: directory });
  assert.equal((await fetch(base + '/escape.html')).status, 404);
});

test('method restrictions and content types are enforced', async () => {
  const { base } = await fixture();
  assert.equal((await fetch(base + '/api/inquiries')).status, 405);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/api/inquiries', { method: 'POST', body: 'hello' })).status, 415);
});

test('security headers, cache validation, HEAD, and health are available', async () => {
  const { base } = await fixture();
  const response = await fetch(base + '/');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  const head = await fetch(base + '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(base + '/', { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 304);
  assert.equal((await (await fetch(base + '/api/health')).json()).status, 'ok');
});

test('missing pages return a branded 404 instead of the homepage', async () => {
  const { base } = await fixture();
  const response = await fetch(base + '/missing-page', { headers: { Accept: 'text/html' } });
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Let’s get back/);
});

test('homepage anchor targets and field descriptions all resolve', async () => {
  const html = await readFile(join(source, 'index.html'), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Every id must be unique');
  for (const match of html.matchAll(/href="#([^"]+)"|aria-(?:describedby|labelledby|controls)="([^"]+)"/g)) {
    for (const id of (match[1] || match[2]).split(' ')) assert.ok(ids.includes(id), `Missing target ${id}`);
  }
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<form[^>]*action="\/api\/inquiries"[^>]*method="post"/);
  assert.ok(!html.includes('fonts.googleapis.com'));
});
