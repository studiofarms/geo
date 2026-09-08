import { id, fail, text, number, date, choice, role, find, hash, notify, coaches, hook, emailDraft, requireMember } from './core.mjs';
/** @param {any} invoice @returns {number} */
export const paid = invoice => invoice.payments.reduce((sum, payment) => sum + payment.amount, 0);
/** @param {any} invoice @returns {string} */
export const invoiceStatus = invoice => paid(invoice) >= invoice.amount ? 'paid' : invoice.status === 'draft' ? 'draft' : Date.parse(invoice.dueDate) < Date.now() ? 'overdue' : paid(invoice) > 0 ? 'partial' : 'issued';
/** @param {any} db @param {any} user @param {string} action @param {any} body @returns {any} */
export function operationsAction(db, user, action, body) {
  if (action === 'create-invoice') {
    role(user); const cohort = find(db.cohorts, body.cohortId);
    const amount = Math.round(number(body.amount, .01, 10000000) * 100);
    const invoice = { id: id(), number: `GC-${new Date().getFullYear()}-${String(db.invoices.length + 1).padStart(3, '0')}`, cohortId: cohort.id, buyerId: cohort.buyerId, title: text(body.title, 160), amount, dueDate: date(body.dueDate), status: 'draft', payments: [], createdAt: new Date().toISOString() };
    db.invoices.push(invoice); return { id: invoice.id };
  }
  if (action === 'issue-invoice') {
    role(user); const invoice = find(db.invoices, body.id);
    if (invoice.status !== 'draft') fail(409, 'This invoice has already been issued.');
    invoice.status = 'issued';
    const buyer = find(db.buyers, invoice.buyerId);
    notify(db, db.users.filter(account => account.buyerId === buyer.id).map(account => account.id), 'An invoice is ready', invoice.title, 'billing');
    emailDraft(db, buyer.billingEmail, `Invoice ${invoice.number}`, 'Your invoice is available in your GoCoach workspace. This is an unsent local draft.');
    return {};
  }
  if (action === 'record-payment') {
    role(user); const invoice = find(db.invoices, body.id);
    if (invoice.status === 'draft') fail(409, 'Issue the invoice before recording a payment.');
    const amount = Math.round(number(body.amount, .01, 10000000) * 100);
    if (amount > invoice.amount - paid(invoice)) fail(422, 'The payment exceeds the outstanding balance.');
    const reference = text(body.reference, 160);
    if (invoice.payments.some(payment => payment.reference === reference)) fail(409, 'This payment reference has already been recorded.');
    const paymentDate = date(body.date);
    if (Date.parse(paymentDate) > Date.now() + 86400000) fail(422, 'A received payment cannot be dated in the future.');
    invoice.payments.push({ id: id(), amount, date: paymentDate, method: text(body.method, 80), reference });
    return {};
  }
  if (action === 'save-contract') {
    role(user); const cohort = find(db.cohorts, body.cohortId);
    const existing = body.id ? find(db.contracts, body.id) : null;
    if (existing && existing.status !== 'draft') fail(409, 'An agreement in review cannot be edited. Create a new agreement for revised terms.');
    const contract = existing || { id: id(), createdAt: new Date().toISOString(), status: 'draft' };
    Object.assign(contract, { cohortId: cohort.id, buyerId: cohort.buyerId, title: text(body.title, 180), terms: text(body.terms, 30000), amount: Math.round(number(body.amount, 0, 10000000) * 100), programName: cohort.name, company: find(db.buyers, cohort.buyerId).company, startDate: cohort.startDate, endDate: cohort.endDate });
    if (!existing) db.contracts.push(contract);
    return { id: contract.id };
  }
  if (action === 'request-contract-review') {
    role(user); const contract = find(db.contracts, body.id);
    if (contract.status !== 'draft') fail(409, 'This agreement is already in review.');
    contract.status = 'in-review'; contract.requestedAt = new Date().toISOString();
    contract.contentHash = hash(JSON.stringify({ title: contract.title, terms: contract.terms, amount: contract.amount, programName: contract.programName, company: contract.company, startDate: contract.startDate, endDate: contract.endDate }));
    notify(db, db.users.filter(account => account.buyerId === contract.buyerId).map(account => account.id), 'An agreement is ready for review', contract.title, 'contracts');
    hook(db, 'docusign.envelope.requested', { contractId: contract.id, contentHash: contract.contentHash }); return {};
  }
  if (action === 'acknowledge-contract') {
    role(user, ['buyer']); const contract = find(db.contracts, body.id);
    if (contract.buyerId !== user.buyerId) fail(403, 'This agreement belongs to another buyer.');
    if (contract.status !== 'in-review') fail(409, 'This agreement is not awaiting acknowledgement.');
    if (body.consent !== true) fail(422, 'Confirm that you have reviewed the agreement.');
    contract.status = 'acknowledged'; contract.acknowledgement = { name: text(body.name, 100), userId: user.id, at: new Date().toISOString(), contentHash: contract.contentHash, method: 'local-prototype' };
    notify(db, coaches(db), 'Agreement acknowledged locally', contract.title, 'contracts'); return {};
  }
  if (action === 'send-message') {
    const recipient = find(db.users, body.recipientId);
    if (recipient.id === user.id) fail(422, 'Choose another person.');
    if (user.role !== 'coach' && recipient.role !== 'coach') {
      const shared = db.cohorts.some(cohort => (user.buyerId === cohort.buyerId || db.enrollments.some(e => e.userId === user.id && e.cohortId === cohort.id && e.status === 'enrolled')) && (recipient.buyerId === cohort.buyerId || db.enrollments.some(e => e.userId === recipient.id && e.cohortId === cohort.id && e.status === 'enrolled')));
      if (!shared || (user.role === 'participant' && recipient.role !== 'buyer')) fail(403, 'You cannot message that account.');
    }
    const message = { id: id(), senderId: user.id, recipientId: recipient.id, body: text(body.message, 5000), createdAt: new Date().toISOString() };
    db.messages.push(message); notify(db, [recipient.id], `Message from ${user.name}`, 'You have a new message in your workspace.', 'messages'); return { id: message.id };
  }
  if (action === 'read-notification') {
    for (const item of db.notifications) if (item.userId === user.id && (!body.id || item.id === body.id)) item.read = true;
    return {};
  }
  if (action === 'save-settings') {
    role(user);
    const startHour = number(body.startHour, 0, 22), endHour = number(body.endHour, 1, 23);
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || endHour <= startHour) fail(422, 'The availability end must be after its start.');
    if (!Array.isArray(body.weekdays) || !body.weekdays.length || body.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) fail(422, 'Choose at least one weekday.');
    try { new Intl.DateTimeFormat('en', { timeZone: body.timeZone }).format(); } catch { fail(422, 'Choose a valid time zone.'); }
    const offsets = body.reminderOffsets || [body.reminderHours || db.settings.reminderHours];
    if (!Array.isArray(offsets) || !offsets.length || offsets.length > 8 || offsets.some(value => !Number.isInteger(value) || value < 1 || value > 168)) fail(422, 'Set 1–8 reminder steps, each between 1 and 168 hours before an event.');
    const reminderOffsets = [...new Set(offsets)].sort((a,b) => b-a);
    Object.assign(db.settings, { startHour, endHour, weekdays: [...new Set(body.weekdays)], timeZone: body.timeZone, reminderHours: reminderOffsets[0], reminderOffsets, remindersEnabled: body.remindersEnabled === true });
    return {};
  }
  return null;
}
/** Generate in-app reminders and unsent email drafts; never contact external services.
 * @param {any} db @param {number} now @returns {{created:number}} */
export function runReminders(db, now = Date.now()) {
  let created = 0;
  if (!db.settings.remindersEnabled) return { created };
  const offsets = db.settings.reminderOffsets || [db.settings.reminderHours];
  const window = Math.max(...offsets) * 3600000;
  const step = deadline => Math.min(...offsets.filter(hours => Date.parse(deadline) - now <= hours * 3600000));
  const reminders = [];
  for (const session of db.sessions) if (session.status === 'scheduled' && Date.parse(session.startsAt) > now && Date.parse(session.startsAt) <= now + window) {
    const users = session.participantId ? [session.participantId] : db.enrollments.filter(e => e.cohortId === session.cohortId && e.status === 'enrolled').map(e => e.userId);
    reminders.push({ key: `session:${session.id}:${session.startsAt}`, lead: step(session.startsAt), users, title: 'Your session is coming up', body: session.title, target: 'sessions' });
  }
  for (const [collection, target] of [['polls', 'availability'], ['surveys', 'surveys']]) for (const item of db[collection]) {
    if (item.status !== 'open' || Date.parse(item.deadline) < now || Date.parse(item.deadline) > now + window) continue;
    const users = db.enrollments.filter(e => e.cohortId === item.cohortId && e.status === 'enrolled' && !item.responses.some(r => r.userId === e.userId)).map(e => e.userId);
    reminders.push({ key: `${collection}:${item.id}:${item.deadline}`, lead: step(item.deadline), users, title: 'A response is due soon', body: item.title, target });
  }
  for (const reminder of reminders) for (const userId of reminder.users) {
    const key = `${reminder.key}:${userId}${offsets.length > 1 ? `:lead-${reminder.lead}` : ''}`;
    if (db.reminders.some(item => item.key === key)) continue;
    notify(db, [userId], reminder.title, reminder.body, reminder.target);
    emailDraft(db, find(db.users, userId).email, reminder.title, reminder.body, key);
    db.reminders.push({ key, at: new Date(now).toISOString() }); created++;
  }
  return { created };
}
