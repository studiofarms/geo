import { randomUUID } from 'node:crypto';
import { mkdir, readFile, open, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {{ name: string, email: string, organization: string, interest: string, message: string, consent: boolean }} Inquiry */
export class RequestError extends Error {
  /** @param {number} status @param {string} message @param {Record<string, string>} fields */
  constructor(status, message, fields = {}) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.fields = fields;
  }
}

/** @param {unknown} input @returns {Inquiry} */
export function validateInquiry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RequestError(400, 'Please check your inquiry and try again.');
  }
  const data = /** @type {Record<string, unknown>} */ (input);
  const fields = {};
  const text = (key, max, required = true) => {
    const value = typeof data[key] === 'string' ? data[key].trim() : '';
    if ((required && !value) || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
      fields[key] = `Please enter ${key === 'name' ? 'your name' : key} (${max} characters or fewer).`;
    }
    return value;
  };
  const name = text('name', 100);
  const email = text('email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = 'Please enter a valid email address.';
  const organization = text('organization', 160, false);
  const message = text('message', 2000, false);
  const interest = text('interest', 40);
  if (!['sponsor', 'participant', 'syllabus'].includes(interest)) fields.interest = 'Please choose an inquiry type.';
  const consent = data.consent === true || data.consent === 'on';
  if (!consent) fields.consent = 'Please agree to being contacted about your inquiry.';
  if (Object.keys(fields).length) throw new RequestError(422, 'Please check the highlighted fields.', fields);
  return { name, email, organization, interest, message, consent };
}

/** Save atomically, reusing the receipt when the same request is retried.
 * @param {string} directory @param {Inquiry} inquiry @param {string} key
 * @returns {Promise<{reference: string, duplicate: boolean}>} */
export async function saveInquiry(directory, inquiry, key) {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(key)) {
    throw new RequestError(400, 'Please refresh the page and try again.');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, `${key}.json`);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const record = { reference: `GC-${randomUUID().slice(0, 8).toUpperCase()}`, receivedAt: new Date().toISOString(), ...inquiry };
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(record, null, 2) + '\n');
    await file.sync();
  } finally { await file.close(); }
  try {
    await link(temporary, destination);
    return { reference: record.reference, duplicate: false };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(destination, 'utf8'));
    if (Object.keys(inquiry).some(field => inquiry[field] !== existing[field])) {
      throw new RequestError(409, 'This request has already been used. Start a new inquiry to change its details.');
    }
    return { reference: existing.reference, duplicate: true };
  } finally { await unlink(temporary).catch(() => {}); }
}
