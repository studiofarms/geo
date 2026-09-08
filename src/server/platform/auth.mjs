import { randomBytes } from 'node:crypto';
import { id, fail, hash, email, text, passwordHash, passwordMatches, publicUser, notify, coaches } from './core.mjs';
/** @param {import('node:http').IncomingMessage} request @returns {string} */
export function sessionToken(request) {
  return (request.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('gc_session='))?.slice(11) || '';
}
/** @param {any} db @param {import('node:http').IncomingMessage} request @returns {any} */
export function currentUser(db, request) {
  const token = sessionToken(request);
  const session = db.authSessions.find(item => item.hash === hash(token) && item.expiresAt > Date.now());
  return session && db.users.find(user => user.id === session.userId && user.active !== false);
}
/** @param {any} db @param {any} user @returns {{token:string,user:object}} */
export function newSession(db, user) {
  db.authSessions = db.authSessions.filter(item => item.expiresAt > Date.now());
  const token = randomBytes(32).toString('hex');
  db.authSessions.push({ id: id(), userId: user.id, hash: hash(token), expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  return { token, user: publicUser(user) };
}
/** @param {any} db @param {any} body @param {string} action @param {boolean} demo @returns {object} */
export function authenticate(db, body, action, demo) {
  if (action === 'demo') {
    if (!demo || !db.demo) fail(403, 'Demo access is disabled on this server.');
    const allowed = db.demoUsers || { coach: 'coach-demo', buyer: 'buyer-demo', participant: 'participant-demo' };
    const user = db.users.find(user => user.id === allowed[body.role]);
    if (!user) fail(422, 'Choose a demo role.');
    return newSession(db, user);
  }
  if (action === 'login') {
    const address = email(body.email);
    const user = db.users.find(user => user.email === address && user.active !== false);
    if (!user || !passwordMatches(body.password, user.passwordHash)) fail(401, 'Email or password is incorrect.');
    return newSession(db, user);
  }
  if (action === 'accept') {
    const invitation = db.invitations.find(item => item.hash === hash(text(body.token, 128)) && item.expiresAt > Date.now() && !item.acceptedAt);
    if (!invitation) fail(410, 'This invitation is expired or has already been used. Ask your coach for a new link.');
    const user = db.users.find(user => user.id === invitation.userId);
    if (user.passwordHash) {
      if (!passwordMatches(body.password, user.passwordHash)) fail(401, 'This email already has an account. Enter your existing password to accept.');
    } else { user.passwordHash = passwordHash(body.password); user.name = text(body.name, 100); }
    invitation.acceptedAt = new Date().toISOString();
    if (invitation.cohortId) {
      const enrollment = db.enrollments.find(item => item.userId === user.id && item.cohortId === invitation.cohortId);
      if (enrollment) enrollment.status = 'enrolled';
    }
    notify(db, coaches(db), 'Invitation accepted', `${user.name} has joined the workspace.`, 'cohorts');
    return newSession(db, user);
  }
  fail(404, 'Authentication action not found.');
}
/** @param {any} db @param {any} user @param {string|null} cohortId @returns {string} */
export function invite(db, user, cohortId = null) {
  const token = randomBytes(32).toString('hex');
  db.invitations = db.invitations.filter(item => !(item.userId === user.id && item.cohortId === cohortId && !item.acceptedAt));
  db.invitations.push({ id: id(), userId: user.id, cohortId, hash: hash(token), expiresAt: Date.now() + 14 * 86400000 });
  return token;
}
