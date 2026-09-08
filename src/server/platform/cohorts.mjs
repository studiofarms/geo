import { id, fail, text, date, email, number, choice, zone, role, find, notify, coaches, emailDraft } from './core.mjs';
import { invite } from './auth.mjs';
import { plusWeeks } from './scheduling.mjs';
/** @param {any} db @param {string} cohortId @param {unknown} values @returns {any[]} */
export function bulkInvite(db, cohortId, values) {
  const cohort = find(db.cohorts, cohortId);
  if (!Array.isArray(values) || !values.length || values.length > 100) fail(422, 'Provide 1–100 email addresses.');
  const addresses = [...new Set(values.map(email))];
  const current = db.enrollments.filter(item => item.cohortId === cohortId && item.status !== 'withdrawn');
  const extra = addresses.filter(address => !current.some(item => db.users.find(user => user.id === item.userId)?.email === address));
  if (current.length + extra.length > cohort.capacity) fail(409, `This cohort has room for ${cohort.capacity - current.length} more participants. Increase capacity before inviting more people.`);
  return addresses.map(address => {
    let user = db.users.find(user => user.email === address);
    if (user && user.role !== 'participant') fail(409, `${address} belongs to a non-participant account.`);
    if (!user) { user = { id: id(), name: address.split('@')[0], email: address, role: 'participant', passwordHash: '' }; db.users.push(user); }
    let enrollment = db.enrollments.find(item => item.cohortId === cohortId && item.userId === user.id);
    if (enrollment && ['enrolled', 'completed'].includes(enrollment.status)) return { email: address, status: 'already-enrolled' };
    if (!enrollment) { enrollment = { id: id(), cohortId, userId: user.id, status: 'invited' }; db.enrollments.push(enrollment); }
    enrollment.status = 'invited';
    const token = invite(db, user, cohortId);
    emailDraft(db, address, `You're invited to ${cohort.name}`, 'A secure invitation link has been generated. Copy and share it from the invitation result. No email has been sent.');
    return { email: address, status: 'invited', token };
  });
}
/** @param {any} db @param {any} user @param {string} action @param {any} body @returns {any} */
export function cohortAction(db, user, action, body) {
  if (action === 'save-buyer') {
    let buyer;
    if (user.role === 'buyer') { if (body.id !== user.buyerId) fail(403, 'You can only edit your own company.'); buyer = find(db.buyers, user.buyerId); }
    else { role(user); buyer = body.id ? find(db.buyers, body.id) : { id: id() }; }
    Object.assign(buyer, { company: text(body.company, 160), contact: text(body.contact, 100), email: email(body.email), billingEmail: email(body.billingEmail || body.email), billingAddress: text(body.billingAddress, 1000, false) });
    if (user.role === 'coach') buyer.notes = text(body.notes, 3000, false);
    if (!body.id) db.buyers.push(buyer);
    return { id: buyer.id };
  }
  if (action === 'invite-buyer') {
    role(user); const buyer = find(db.buyers, body.id);
    let account = db.users.find(item => item.email === buyer.email);
    if (account && (account.role !== 'buyer' || account.buyerId !== buyer.id)) fail(409, 'This email belongs to a different account.');
    if (!account) { account = { id: id(), name: buyer.contact, email: buyer.email, role: 'buyer', buyerId: buyer.id, passwordHash: '' }; db.users.push(account); }
    return { invitations: [{ email: account.email, status: 'invited', token: invite(db, account) }] };
  }
  if (action === 'save-cohort') {
    role(user); find(db.buyers, body.buyerId);
    const startDate = date(body.startDate), endDate = date(body.endDate);
    if (endDate <= startDate) fail(422, 'The end date must follow the start date.');
    const capacity = number(body.capacity, 2, 50);
    if (!Number.isInteger(capacity)) fail(422, 'Capacity must be a whole number.');
    const cohort = body.id ? find(db.cohorts, body.id) : { id: id(), createdAt: new Date().toISOString() };
    const count = db.enrollments.filter(item => item.cohortId === cohort.id && item.status !== 'withdrawn').length;
    if (capacity < count) fail(409, 'Capacity cannot be lower than the current roster.');
    if (body.id && cohort.buyerId !== body.buyerId) fail(409, 'Create a new cohort to change the owning buyer; existing reports and billing remain with their original account.');
    Object.assign(cohort, { name: text(body.name, 160), buyerId: body.buyerId, startDate, endDate, capacity, timeZone: zone(body.timeZone), price: Math.round(number(body.price, 0, 1000000) * 100), description: text(body.description, 2000, false), status: choice(body.status || 'enrolling', ['draft', 'enrolling', 'active', 'completed']) });
    if (!body.id) {
      db.cohorts.push(cohort);
      ['Baseline', 'The interior work', 'Under pressure', 'Across', 'Who stays', 'Integration'].forEach((title, i) => db.sessions.push({ id: id(), cohortId: cohort.id, title, startsAt: plusWeeks(startDate, [0,2,4,6,8,11][i], cohort.timeZone), duration: 90, status: 'draft', kind: 'cohort', meetingUrl: '', materials: '', summary: '', privateNotes: '' }));
    }
    const invitations = body.emails?.length ? bulkInvite(db, cohort.id, body.emails) : [];
    return { id: cohort.id, invitations };
  }
  if (action === 'bulk-invite') { role(user); return { invitations: bulkInvite(db, body.cohortId, body.emails) }; }
  if (action === 'enrollment-status') {
    role(user); const enrollment = find(db.enrollments, body.id);
    const status = choice(body.status, ['invited', 'enrolled', 'completed', 'withdrawn']);
    if (enrollment.status === 'withdrawn' && status !== 'withdrawn') {
      const cohort = find(db.cohorts, enrollment.cohortId);
      if (db.enrollments.filter(item => item.cohortId === cohort.id && item.status !== 'withdrawn').length >= cohort.capacity) fail(409, 'This cohort is full.');
    }
    enrollment.status = status; return {};
  }
  if (action === 'save-lead') {
    role(user); const lead = body.id ? find(db.leads, body.id) : { id: id(), createdAt: new Date().toISOString() };
    Object.assign(lead, { name: text(body.name, 100), email: email(body.email), company: text(body.company, 160, false), stage: choice(body.stage, ['discovery', 'proposal', 'closed', 'lost']), value: Math.round(number(body.value, 0, 10000000) * 100), note: text(body.note, 5000, false) });
    if (!body.id) db.leads.push(lead); return { id: lead.id };
  }
  if (action === 'lead-stage') { role(user); find(db.leads, body.id).stage = choice(body.stage, ['discovery', 'proposal', 'closed', 'lost']); return {}; }
  return null;
}
