import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { resolve, sep, extname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { RequestError, validateInquiry, saveInquiry } from './inquiries.mjs';
import { createPlatform } from './platform/router.mjs';
import { Readable } from 'node:stream';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };
const limit = 16384;
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src https://calendly.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

/** @param {import('node:http').IncomingMessage} request @returns {Promise<Record<string, unknown>>} */
async function readBody(request) {
  if (Number(request.headers['content-length']) > limit) throw new RequestError(413, 'Your inquiry is too long. Please shorten it and try again.');
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new RequestError(413, 'Your inquiry is too long. Please shorten it and try again.');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = request.headers['content-type']?.split(';')[0];
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  if (type !== 'application/json') throw new RequestError(415, 'Please submit the inquiry form on this website.');
  try { return JSON.parse(raw); } catch { throw new RequestError(400, 'We could not read your inquiry. Please try again.'); }
}

/** @param {{ root: string, dataDirectory: string, platformDirectory?: string, development?: boolean, publicOrigin?: string, rateLimit?: number }} options
 * @returns {import('node:http').Server} */
export function createApp({ root, dataDirectory, platformDirectory, development = false, publicOrigin, rateLimit = 10, apiHandler }) {
  const platform = apiHandler?null:createPlatform({ directory: platformDirectory || resolve(dataDirectory, '..', development ? 'platform-development' : 'platform-production'), inquiryDirectory: dataDirectory, development });
  const clients = new Set();
  const attempts = new Map();
  const staticRoot = resolve(root);
  const rateWindow = 15 * 60 * 1000;
  const timer = setInterval(() => {
    for (const [key, value] of attempts) if (value.until <= Date.now()) attempts.delete(key);
  }, 60_000).unref();
  const watcher = development ? watch(staticRoot, { recursive: true }, () => {
    for (const client of clients) client.write('data: reload\n\n');
  }) : null;
  const server = createServer(async (request, response) => {
    for (const [key, value] of Object.entries(securityHeaders)) response.setHeader(key, value);
    response.setHeader('Cache-Control', 'no-store');
    const json = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    try {
      const port = server.address()?.port;
      const loopbackOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
      const allowedOrigins = publicOrigin ? [new URL(publicOrigin).origin, ...(development ? loopbackOrigins : [])] : loopbackOrigins;
      if (!allowedOrigins.some(origin => new URL(origin).host === request.headers.host)) throw new RequestError(403, 'This host is not allowed.');
      const url = new URL(request.url, allowedOrigins[0]);
      const path = decodeURIComponent(url.pathname);
      if(apiHandler&&path.startsWith('/api/')){
        const webRequest=new Request(url,{method:request.method,headers:request.headers,body:['GET','HEAD'].includes(request.method)?undefined:Readable.toWeb(request),duplex:'half'});
        const result=await apiHandler(webRequest,{ip:request.socket.remoteAddress});
        response.writeHead(result.status,Object.fromEntries(result.headers));response.end(Buffer.from(await result.arrayBuffer()));return;
      }
      if (await platform?.handle(request, response, url, allowedOrigins)) return;
      if (path === '/api/inquiries') {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          throw new RequestError(405, 'Use the inquiry form to submit a request.');
        }
        if (request.headers.origin && !allowedOrigins.includes(request.headers.origin)) throw new RequestError(403, 'Please submit from the GoCoach website.');
        if (request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Please submit from the GoCoach website.');
        const ip = request.socket.remoteAddress;
        const record = attempts.get(ip);
        const attempt = record && record.until > Date.now() ? record : { count: 0, until: Date.now() + rateWindow };
        attempts.set(ip, attempt);
        if (++attempt.count > rateLimit) {
          response.setHeader('Retry-After', Math.ceil((attempt.until - Date.now()) / 1000));
          throw new RequestError(429, 'Too many attempts. Please try again in 15 minutes.');
        }
        const body = await readBody(request);
        if (body && typeof body === 'object' && body.website) throw new RequestError(422, 'Please leave the website field empty.');
        const inquiry = validateInquiry(body);
        const key = request.headers['idempotency-key'] || body.requestId || randomUUID();
        if (typeof key !== 'string') throw new RequestError(400, 'Invalid inquiry reference.');
        const receipt = await saveInquiry(dataDirectory, inquiry, key);
        if (request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
          response.writeHead(303, { Location: '/inquiry-received.html' });
          return response.end();
        }
        return json(receipt.duplicate ? 200 : 201, { ...receipt, delivery: 'local', message: 'Your inquiry has been saved on this development server. No email has been sent.' });
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        throw new RequestError(405, 'Method not allowed.');
      }
      if (path === '/api/health') return json(200, { status: 'ok', mode: development ? 'development' : 'production', inquiryDelivery: 'local' });
      if (development && path === '/__dev/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        response.write(': connected\n\n');
        clients.add(response);
        request.on('close', () => clients.delete(response));
        return;
      }
      if (development && path === '/__dev/live.js') {
        response.writeHead(200, { 'Content-Type': types['.js'] });
        return response.end("new EventSource('/__dev/events').onmessage = () => location.reload();");
      }
      if (path.includes('\\') || path.includes('\0') || path.split('/').some(part => part.startsWith('.'))) throw new RequestError(404, 'Page not found.');
      let filename = resolve(staticRoot, `.${path === '/' ? '/index.html' : path}`);
      if (!filename.startsWith(staticRoot + sep) || !types[extname(filename)]) throw new RequestError(404, 'Page not found.');
      try {
        filename = await realpath(filename);
        if (!filename.startsWith(staticRoot + sep) || !(await stat(filename)).isFile()) throw new RequestError(404, 'Page not found.');
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new RequestError(404, 'Page not found.');
        throw error;
      }
      let content = await readFile(filename);
      if (development && filename.endsWith('.html')) content = Buffer.from(content.toString().replace('</body>', '<script src="/__dev/live.js" defer></script></body>'));
      const etag = `"${createHash('sha256').update(content).digest('hex').slice(0, 20)}"`;
      response.setHeader('ETag', etag);
      response.setHeader('Cache-Control', development ? 'no-store' : 'public, max-age=0, must-revalidate');
      if (request.headers['if-none-match'] === etag) { response.writeHead(304); return response.end(); }
      response.writeHead(200, { 'Content-Type': types[extname(filename)], 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const status = error instanceof RequestError ? error.status : error instanceof URIError ? 400 : 500;
      if (status === 500) console.error('Request failed:', error.code || error.name);
      if (status === 404 && request.headers.accept?.includes('text/html')) {
        response.writeHead(404, { 'Content-Type': types['.html'] });
        return response.end(await readFile(resolve(staticRoot, '404.html')).catch(() => 'Page not found.'));
      }
      json(status, { error: status === 500 ? 'We could not complete this request. Please try again.' : error.message, fields: error.fields || {} });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('close', () => { clearInterval(timer); platform?.close(); watcher?.close(); for (const client of clients) client.end(); });
  return server;
}
