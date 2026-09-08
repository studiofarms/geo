import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { RequestError } from '../inquiries.mjs';
export { RequestError };
/** @returns {string} */
export const id = () => randomUUID();
/** @param {number} status @param {string} message */
export const fail = (status, message) => { throw new RequestError(status, message); };
/** @param {unknown} value @param {number} max @param {boolean} required @returns {string} */
export function text(value, max = 200, required = true) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    if (!required && (value === undefined || value === null)) return '';
    fail(422, `Please enter valid text, up to ${max.toLocaleString()} characters.`);
  }
  return value.trim();
}
/** @param {unknown} value @returns {string} */
export function email(value) {
  const result = text(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(422, 'Please enter a valid email address.');
  return result;
}
/** @param {unknown} value @param {string[]} choices @returns {string} */
export const choice = (value, choices) => choices.includes(value) ? value : fail(422, `Choose one of: ${choices.join(', ')}.`);
/** @param {unknown} value @param {number} min @param {number} max @returns {number} */
export function number(value, min = 0, max = 100000000) {
  if (value === '' || value === null || typeof value === 'boolean' || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) fail(422, 'Please enter a number within the allowed range.');
  return Number(value);
}
/** @param {unknown} value @returns {string} */
export function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(T|$)/.test(value) || !Number.isFinite(Date.parse(value))) fail(422, 'Please enter a valid date.');
  return new Date(value).toISOString();
}
/** @param {unknown} value @returns {string} */
export function zone(value = 'America/Chicago') {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return value; }
  catch { fail(422, 'Choose a valid time zone.'); }
}
/** @param {unknown} value @returns {string} */
export function meetingURL(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url.href;
  } catch { fail(422, 'Enter an HTTPS meeting URL.'); }
}
/** @param {any[]} collection @param {string} key @returns {any} */
export const find = (collection, key) => collection.find(item => item.id === key) || fail(404, 'This record was not found.');
/** @param {any} user @param {string[]} roles */
export const role = (user, roles = ['coach']) => { if (!user || !roles.includes(user.role)) fail(403, 'Your account does not have access to this action.'); };
/** @param {any} db @param {any} user @param {string} cohortId @returns {boolean} */
export function member(db, user, cohortId) {
  const cohort = db.cohorts.find(item => item.id === cohortId);
  return !!cohort && (user.role === 'coach' || (user.role === 'buyer' && cohort.buyerId === user.buyerId) || db.enrollments.some(item => item.cohortId === cohortId && item.userId === user.id && ['enrolled', 'completed'].includes(item.status)));
}
/** @param {any} db @param {any} user @param {string} cohortId */
export const requireMember = (db, user, cohortId) => { if (!member(db, user, cohortId)) fail(403, 'You do not have access to this cohort.'); };
/** @param {string} value @returns {string} */
export const hash = value => createHash('sha256').update(value).digest('hex');
/** @param {string} password @returns {string} */
export function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail(422, 'Use a password between 12 and 128 characters.');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
/** @param {string} password @param {string} stored @returns {boolean} */
export function passwordMatches(password, stored) {
  const [salt, digest] = (stored || '').split(':');
  if (!salt || !digest || typeof password !== 'string' || password.length > 128) return false;
  const derived = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
/** @param {any} user @returns {object} */
export const publicUser = ({ id, name, email, role, buyerId }) => ({ id, name, email, role, buyerId });
/** @param {any} db @param {string[]} users @param {string} title @param {string} body @param {string} target */
export function notify(db, users, title, body, target = 'dashboard') {
  for (const userId of new Set(users)) db.notifications.push({ id: id(), userId, title, body, target, read: false, createdAt: new Date().toISOString() });
}
/** @param {any} db @param {string} cohortId @returns {string[]} */
export const participants = (db, cohortId) => db.enrollments.filter(item => item.cohortId === cohortId && item.status === 'enrolled').map(item => item.userId);
/** @param {any} db @returns {string[]} */
export const coaches = db => db.users.filter(user => user.role === 'coach').map(user => user.id);
/** @param {any} db @param {string} kind @param {object} payload */
export function hook(db, kind, payload) {
  db.hooks.push({ id: id(), kind, payload, createdAt: new Date().toISOString(), status: 'not-connected' });
}
/** @param {any} db @param {string} recipient @param {string} subject @param {string} body @param {string} key */
export function emailDraft(db, recipient, subject, body, key = id()) {
  if (db.outbox.some(item => item.key === key)) return;
  db.outbox.push({ id: id(), key, recipient, subject, body, status: 'draft-local', createdAt: new Date().toISOString() });
}
