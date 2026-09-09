import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { id, fail, hash, text, email, role, find, notify, coaches, publicUser } from './core.mjs';
import { authenticate, currentUser, sessionToken } from './auth.mjs';
import { availableSlots, book, schedulingAction, calendarFile } from './scheduling.mjs';
import { cohortAction } from './cohorts.mjs';
import { contentAction, documentAccess } from './content.mjs';
import { operationsAction, runReminders } from './operations.mjs';
import { snapshot, sessionAccess, canJoin } from './visibility.mjs';
/** @param {import('node:http').IncomingMessage} request @returns {Promise<any>} */
async function bodyJSON(request) {
  const max = 8 * 1024 * 1024;
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, 'Submit JSON from the GoCoach application.');
  if (Number(request.headers['content-length']) > max) fail(413, 'This request exceeds the 8 MB limit.');
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > max) fail(413, 'This request is too large.'); chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'The request could not be read.'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, 'Expected a JSON object.');
  return body;
}
/** @param {{ directory?:string, inquiryDirectory?:string, development:boolean, store?:any, timers?:boolean, calendly?:any }} options @returns {any} */
export function createPlatform({ directory, inquiryDirectory, development, store: injectedStore, timers = true, calendly, zoom }) {
  const store = injectedStore || new Store(directory, development);
  const rate = new Map();
  let started = false;
  const reminderTimer = timers ? setInterval(() => {
    for (const [key, value] of rate) if (value.until < Date.now()) rate.delete(key);
    if (started) store.run(db => runReminders(db), true).catch(error => console.error('Reminder processing failed:', error.code || error.name));
  }, 60000).unref() : null;
  const integrationStatus = [
    { id: 'google', name: 'Google Calendar', description: 'Per-session calendar files and event hooks are ready. OAuth sync is not connected.' },
    { id: 'outlook', name: 'Outlook Calendar', description: 'Import a session calendar file into Outlook. Account sync is not connected.' },
    { id: 'video', name: 'Zoom / Google Meet', description: 'Add an HTTPS meeting link to each session. Automatic room creation is not connected.' },
    { id: 'email', name: 'Email delivery', description: 'Invitations and reminders are prepared as local drafts. No email is sent.' },
    { id: 'docusign', name: 'DocuSign', description: 'Agreement review and event hooks are ready. Local acknowledgements are not DocuSign signatures.' },
    { id: 'payments', name: 'Payment processing', description: 'Invoices and manual payment records work locally. No card is charged.' },
  ].map(item => ({ ...item, status: 'not-connected' }));
  async function importInquiries(db) {
    if (!inquiryDirectory) return;
    const files = await readdir(inquiryDirectory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const filename of files.filter(name => /^[a-f\d-]+\.json$/i.test(name))) {
      const inquiry = JSON.parse(await readFile(join(inquiryDirectory, filename), 'utf8'));
      if (db.leads.some(lead => lead.inquiryReference === inquiry.reference)) continue;
      db.leads.push({ id: id(), name: inquiry.name, email: inquiry.email, company: inquiry.organization, note: inquiry.message, stage: 'discovery', value: 0, inquiryReference: inquiry.reference, createdAt: inquiry.receivedAt });
    }
  }
  return {
    store,
    close() { clearInterval(reminderTimer); },
    /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @param {URL} url @param {string[]} allowedOrigins @returns {Promise<boolean>} */
    async handle(request, response, url, allowedOrigins) {
      if (!url.pathname.startsWith('/api/platform/')) return false;
      started = true;
      const path = url.pathname.slice('/api/platform/'.length);
      const json = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); return true; };
      const download = (content, mime, name) => { response.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store' }); response.end(content); return true; };
      if (!['GET', 'POST'].includes(request.method)) { response.setHeader('Allow', 'GET, POST'); fail(405, 'Method not allowed.'); }
      if (request.method === 'POST') {
        if ((request.headers.origin && !allowedOrigins.includes(request.headers.origin)) || request.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Submit from the GoCoach website.');
        const key = `${request.socket.remoteAddress}:${path.startsWith('auth/') ? 'auth' : path.startsWith('public/') ? 'public' : 'actions'}`;
        if (store.takeRate) await store.takeRate(key,path.startsWith('auth/')?15:path.startsWith('public/')?20:120);
        const bucket = rate.get(key);
        const current = bucket && bucket.until > Date.now() ? bucket : { count: 0, until: Date.now() + 60000 };
        rate.set(key, current);
        if (++current.count > (path.startsWith('auth/') ? 15 : path.startsWith('public/') ? 20 : 120)) { response.setHeader('Retry-After', '60'); fail(429, 'Too many requests. Please try again in a minute.'); }
      }
      if (request.method === 'GET' && path === 'public/config') return json(200, { demoEnabled: development, storage:store.database?'postgres':'local', integrations: integrationStatus,calendly:calendly?await calendly.publicConfig():{enabled:false,available:false} });
      if (request.method === 'GET' && path === 'public/slots') return json(200, await store.run(db => ({ slots: availableSlots(db, url.searchParams.get('from') || new Date().toISOString().slice(0,10), Number(url.searchParams.get('days') || 14)), timeZone: db.settings.timeZone, duration: 30, price: 0 })));
      if (request.method === 'GET' && path === 'public/booking-calendar') {
        const session = await store.run(db => db.sessions.find(item => item.cancellationHash === hash(text(url.searchParams.get('token'), 128))));
        if (!session) fail(404, 'Booking not found.');
        return download(calendarFile(session), 'text/calendar; charset=utf-8', 'gocoach-booking.ics');
      }
      if (request.method === 'GET' && path === 'public/invitation') return json(200, await store.run(db => {
        const invitation = db.invitations.find(item => item.hash === hash(text(url.searchParams.get('token'), 128)) && !item.acceptedAt && item.expiresAt > Date.now());
        if (!invitation) fail(410, 'This invitation has expired or has already been used.');
        const user = find(db.users, invitation.userId);
        return { name: user.name, email: user.email, existingAccount: !!user.passwordHash, cohortName: invitation.cohortId ? find(db.cohorts, invitation.cohortId).name : 'Your buyer workspace' };
      }));
      if (request.method === 'POST' && ['auth/demo', 'auth/login', 'auth/accept'].includes(path)) {
        const body = await bodyJSON(request);
        const result = await store.run(db => authenticate(db, body, path.split('/')[1], development), true);
        response.setHeader('Set-Cookie', `gc_session=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${allowedOrigins[0].startsWith('https:') ? '; Secure' : ''}`);
        return json(200, { user: result.user });
      }
      if (request.method === 'POST' && path === 'public/book') {
        if(calendly&&(await calendly.publicConfig()).enabled)fail(409,'Use the Calendly booking widget to reserve this call.');
        const body = await bodyJSON(request);
        if (body.website) fail(422, 'Please leave the website field empty.');
        return json(201, await store.run(db => {
          db.bookingRequests ||= [];
          if (body.requestId && !/^[a-f\d-]{36}$/.test(body.requestId)) fail(400, 'Invalid booking request.');
          const fingerprint = hash(JSON.stringify(body));
          const previous = body.requestId && db.bookingRequests.find(item => item.key === body.requestId);
          if (previous) { if (previous.fingerprint !== fingerprint) fail(409, 'This booking request has changed. Refresh the calendar to start again.'); return previous.result; }
          const result = book(db, body);
          if (body.requestId) db.bookingRequests.push({ key: body.requestId, fingerprint, result });
          return result;
        }, true));
      }
      if (request.method === 'POST' && path === 'public/subscribe') {
        const body = await bodyJSON(request);
        const result = await store.run(db => {
          if (body.consent !== true || body.website) fail(422, 'Please consent to joining the mailing list.');
          const address = email(body.email);
          let subscriber = db.subscribers.find(item => item.email === address);
          if (subscriber && subscriber.status === 'subscribed') return { message: 'Your mailing-list preference has been saved. Email delivery is not connected.' };
          const token = randomBytes(32).toString('hex');
          if (!subscriber) { subscriber = { id: id(), email: address }; db.subscribers.push(subscriber); }
          Object.assign(subscriber, { status: 'subscribed', consentAt: new Date().toISOString(), tokenHash: hash(token) });
          return { message: 'You are on the GoCoach mailing list. Email delivery is not connected.', unsubscribeToken: token };
        }, true);
        return json(200, result);
      }
      if (request.method === 'POST' && path === 'public/unsubscribe') {
        const body = await bodyJSON(request);
        await store.run(db => { const subscriber = db.subscribers.find(item => item.tokenHash === hash(text(body.token, 128))); if (subscriber) subscriber.status = 'unsubscribed'; }, true);
        return json(200, { message: 'Your mailing-list preference has been updated.' });
      }
      if (request.method === 'POST' && path === 'public/cancel-booking') {
        const body = await bodyJSON(request);
        await store.run(db => { const session = db.sessions.find(item => item.cancellationHash === hash(text(body.token, 128))); if (!session) fail(404, 'Booking not found.'); if (Date.parse(session.startsAt) < Date.now()) fail(409, 'This booking has already started.'); session.status = 'cancelled'; }, true);
        return json(200, { message: 'The booking is cancelled.' });
      }
      const user = await store.run(db => currentUser(db, request));
      if (!user) fail(401, 'Please sign in to your workspace.');
      if(path.startsWith('zoom/')){
        if(!zoom)fail(503,'Connect PostgreSQL to configure Zoom securely.');
        if(request.method==='GET'&&path==='zoom/settings')return json(200,await zoom.settings(user));
        if(request.method==='POST'){
          const body=await bodyJSON(request);
          if(path==='zoom/connect')return json(200,await zoom.save(user,body));
          if(path==='zoom/disconnect')return json(200,await zoom.disconnect(user));
          if(path==='zoom/sync')return json(200,await zoom.sync(user,body.sessionId));
          if(path==='zoom/remove')return json(200,await zoom.sync(user,body.sessionId,true));
        }
        fail(404,'Zoom operation not found.');
      }
      if(path.startsWith('calendly/')){
        if(!calendly)fail(503,'Connect PostgreSQL to configure Calendly securely.');
        if(request.method==='GET'&&path==='calendly/settings')return json(200,await calendly.settings(user));
        if(request.method==='POST'){
          const body=await bodyJSON(request);
          if(path==='calendly/connect')return json(200,await calendly.save(user,body));
          if(path==='calendly/webhook')return json(200,await calendly.enableWebhook(user));
          if(path==='calendly/disconnect')return json(200,await calendly.disconnect(user));
          if(path==='calendly/booking-link')return json(200,await calendly.participantLink(user,body.cohortId));
        }
        fail(404,'Calendly operation not found.');
      }
      if (request.method === 'POST' && path === 'auth/logout') {
        await store.run(db => { db.authSessions = db.authSessions.filter(session => session.hash !== hash(sessionToken(request))); }, true);
        response.setHeader('Set-Cookie', 'gc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); return json(200, {});
      }
      if (request.method === 'GET' && path === 'state') return json(200, { ...await store.run(async db => {
        if (user.role === 'coach') await importInquiries(db);
        return { ...snapshot(db, user), integrations: integrationStatus };
      }, user.role === 'coach'),storage:store.database?'postgres':'local',calendly:calendly?(user.role==='coach'?await calendly.settings(user):await calendly.publicConfig()):{available:false,enabled:false},zoom:zoom&&user.role==='coach'?await zoom.settings(user):{available:false} });
      if (request.method === 'GET' && path.startsWith('documents/')) {
        const document = await store.run(db => { const item = find(db.documents, path.split('/')[1]); if (!documentAccess(db, user, item)) fail(403, 'This document is not shared with your account.'); return item; });
        const bytes = document.inlineContent ? Buffer.from(document.inlineContent) : store.readFile ? await store.readFile(document.fileId || document.id) : await readFile(join(directory, 'files', document.id));
        return download(bytes, document.mime, document.originalName.replace(/[^a-zA-Z0-9._ -]/g, '_'));
      }
      if (request.method === 'GET' && path.startsWith('sessions/')) {
        const [, key, task] = path.split('/');
        const session = await store.run(db => { const session = find(db.sessions, key); if (!sessionAccess(db, user, session)) fail(403, 'You cannot access this session.'); return session; });
        if (task === 'calendar') return download(calendarFile({ ...session, meetingUrl: user.role === 'buyer' ? '' : session.meetingUrl }), 'text/calendar; charset=utf-8', 'gocoach-session.ics');
        if (task === 'join') { if (!canJoin(session, user)) fail(403, 'Joining opens 15 minutes before the session, once the coach has added a meeting link.'); return json(200, { url: session.meetingUrl }); }
      }
      if (request.method === 'GET' && path === 'export') {
        role(user); const collection = url.searchParams.get('collection');
        if (!['subscribers', 'leads', 'outbox', 'hooks', 'audit'].includes(collection)) fail(422, 'Choose an available export.');
        const data = await store.run(db => db[collection].map(({ tokenHash, ...item }) => item));
        return download(JSON.stringify(data, null, 2), 'application/json', `gocoach-${collection}.json`);
      }
      if (request.method === 'POST' && path === 'action') {
        const body = await bodyJSON(request); const action = text(body.action, 80); const payload = body.payload;
        if(action==='book-one-to-one'&&calendly&&(await calendly.publicConfig()).enabled)fail(409,'Use Calendly to book this 1:1.');
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, 'Expected an action payload.');
        const requestKey = request.headers['idempotency-key'];
        if (requestKey && !/^[a-f\d-]{36}$/.test(requestKey)) fail(400, 'Invalid request key.');
        const result = await store.run(async db => {
          db.requests ||= [];
          const fingerprint = hash(JSON.stringify({ action, payload }));
          const previous = requestKey && db.requests.find(item => item.key === requestKey && item.userId === user.id);
          if (previous) { if (previous.fingerprint !== fingerprint) fail(409, 'This request key was already used.'); return previous.result; }
          let result;
          if (action === 'run-reminders') { role(user); result = runReminders(db); }
          else result = cohortAction(db, user, action, payload) ?? schedulingAction(db, user, action, payload) ?? await contentAction(db, user, action, payload, directory, !!store.database) ?? operationsAction(db, user, action, payload);
          if (result === null || result === undefined) fail(404, 'Action not found.');
          db.audit.push({ id: id(), userId: user.id, action, recordId: payload.id || result.id || null, at: new Date().toISOString() });
          if (requestKey) { db.requests.push({ key: requestKey, userId: user.id, fingerprint, result }); db.requests = db.requests.slice(-2000); }
          return result;
        }, true);
        return json(200, result);
      }
      fail(404, 'Endpoint not found.');
    },
  };
}
