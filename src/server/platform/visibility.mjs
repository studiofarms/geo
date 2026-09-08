import { member, publicUser } from './core.mjs';
import { documentAccess, reportAccess } from './content.mjs';
import { invoiceStatus, paid } from './operations.mjs';
/** @param {any} db @param {any} user @param {any} session @returns {boolean} */
export function sessionAccess(db, user, session) {
  if (user.role === 'coach') return true;
  if (!session.cohortId || !member(db, user, session.cohortId)) return false;
  return session.kind === 'cohort' || session.participantId === user.id;
}
/** @param {any} session @param {any} user @param {number} now @returns {boolean} */
export const canJoin = (session, user, now = Date.now()) => user.role !== 'buyer' && session.status === 'scheduled' && !!session.meetingUrl && now >= Date.parse(session.startsAt) - 15 * 60000 && now <= Date.parse(session.startsAt) + (session.duration + 30) * 60000;
/** @param {any} db @param {any} user @returns {any} */
export function snapshot(db, user) {
  const coach = user.role === 'coach';
  const cohorts = db.cohorts.filter(cohort => member(db, user, cohort.id));
  const cohortIds = new Set(cohorts.map(item => item.id));
  const buyerIds = new Set(cohorts.map(item => item.buyerId));
  if (user.buyerId) buyerIds.add(user.buyerId);
  const enrollments = db.enrollments.filter(item => cohortIds.has(item.cohortId) && (coach || user.role === 'buyer' || item.userId === user.id));
  const contactIds = new Set(enrollments.map(item => item.userId));
  contactIds.add(user.id);
  const users = db.users.filter(account => coach || account.role === 'coach' || contactIds.has(account.id) || (account.role === 'buyer' && buyerIds.has(account.buyerId))).map(publicUser);
  const sessions = db.sessions.filter(session => sessionAccess(db, user, session)).map(session => {
    const { privateNotes, cancellationHash, contact, meetingUrl, rescheduleUrl, cancelUrl, ...visible } = session;
    return { ...visible, ...(coach || session.participantId===user.id ? {rescheduleUrl,cancelUrl} : {}), ...(coach ? { privateNotes, contact, meetingUrl } : { meetingUrl: canJoin(session, user) ? meetingUrl : '' }), hasMeetingUrl: !!meetingUrl, joinable: canJoin(session, user) };
  });
  const polls = db.polls.filter(item => cohortIds.has(item.cohortId)).map(poll => ({ ...poll, responseCount: poll.responses.length, responses: coach ? poll.responses : poll.responses.filter(response => response.userId === user.id) }));
  const surveys = db.surveys.filter(item => cohortIds.has(item.cohortId) && (coach || item.status !== 'draft')).map(survey => ({ ...survey, responseCount: survey.responses.length, averages: user.role !== 'participant' ? survey.questions.map((_, index) => survey.responses.length ? survey.responses.reduce((sum, response) => sum + response.answers[index], 0) / survey.responses.length : null) : [], responses: coach ? survey.responses : survey.responses.filter(response => response.userId === user.id) }));
  const invoices = db.invoices.filter(invoice => coach || (user.role === 'buyer' && invoice.buyerId === user.buyerId && invoice.status !== 'draft')).map(invoice => ({ ...invoice, displayStatus: invoiceStatus(invoice), paid: paid(invoice), balance: invoice.amount - paid(invoice) }));
  return {
    user: publicUser(user), demo: db.demo, serverTime: new Date().toISOString(), settings: coach ? db.settings : { timeZone: db.settings.timeZone }, users,
    cohorts: cohorts.map(cohort => ({ ...cohort, enrolledCount: db.enrollments.filter(e => e.cohortId === cohort.id && e.status === 'enrolled').length, rosterCount: db.enrollments.filter(e => e.cohortId === cohort.id && e.status !== 'withdrawn').length })),
    buyers: db.buyers.filter(buyer => coach || (user.role === 'buyer' && buyer.id === user.buyerId)).map(buyer => coach ? buyer : (({ notes, ...visible }) => visible)(buyer)),
    enrollments, sessions, polls, surveys, invoices,
    documents: db.documents.filter(document => documentAccess(db, user, document)).map(({ inlineContent, ...document }) => document),
    reports: db.reports.filter(report => reportAccess(db, user, report)),
    contracts: db.contracts.filter(contract => coach || (user.role === 'buyer' && contract.buyerId === user.buyerId && contract.status !== 'draft')),
    notifications: db.notifications.filter(notification => notification.userId === user.id).sort((a,b) => b.createdAt.localeCompare(a.createdAt)),
    messages: db.messages.filter(message => message.senderId === user.id || message.recipientId === user.id),
    ...(coach ? { leads: db.leads, subscribers: db.subscribers.map(({ tokenHash, ...subscriber }) => subscriber), outbox: db.outbox, hooks: db.hooks, audit: db.audit.slice(-100) } : {}),
  };
}
