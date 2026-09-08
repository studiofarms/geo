import { id, fail, date, text, number, choice, role, find, requireMember, participants, notify, coaches, hook, email, hash, meetingURL } from './core.mjs';
import { randomBytes } from 'node:crypto';
const hour = 3600000;
/** @param {Date|string} instant @param {string} timeZone @returns {any} */
function parts(instant, timeZone) {
  const values = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
  return Object.fromEntries(values.filter(item => item.type !== 'literal').map(item => [item.type, Number(item.value)]));
}
/** Convert a wall-clock time to an instant; scheduling preserves local time across DST.
 * @param {string} day @param {number} hours @param {number} minutes @param {string} timeZone @returns {string} */
export function zonedInstant(day, hours, minutes, timeZone) {
  const [year, month, dayNumber] = day.split('-').map(Number);
  const wanted = Date.UTC(year, month - 1, dayNumber, hours, minutes);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(guess), timeZone);
    guess += wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return new Date(guess).toISOString();
}
/** @param {string} instant @param {number} weeks @param {string} timeZone @returns {string} */
export function plusWeeks(instant, weeks, timeZone) {
  const p = parts(instant, timeZone);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + 7 * weeks)).toISOString().slice(0, 10);
  return zonedInstant(day, p.hour, p.minute, timeZone);
}
/** @param {any} db @param {string} startsAt @param {number} duration @param {string[]} exclude @returns {boolean} */
export function busy(db, startsAt, duration, exclude = []) {
  const start = Date.parse(startsAt), end = start + duration * 60000;
  return db.sessions.some(item => !exclude.includes(item.id) && item.status === 'scheduled' && Date.parse(item.startsAt) < end && Date.parse(item.startsAt) + item.duration * 60000 > start);
}
/** @param {any} db @param {string} from @param {number} days @returns {string[]} */
export function availableSlots(db, from, days = 14) {
  const first = date(from).slice(0, 10);
  if (Date.parse(first) > Date.now() + 90 * 86400000 || Date.parse(first) < Date.now() - 2 * 86400000) fail(422, 'Choose a date within the next 90 days.');
  const slots = [];
  for (let i = 0; i < Math.min(31, days); i++) {
    const day = new Date(Date.parse(first) + i * 86400000).toISOString().slice(0, 10);
    if (!db.settings.weekdays.includes(new Date(day + 'T12:00:00Z').getUTCDay())) continue;
    for (let h = db.settings.startHour; h < db.settings.endHour; h++) for (const minute of [0, 30]) {
      const value = zonedInstant(day, h, minute, db.settings.timeZone);
      if (Date.parse(value) > Date.now() + 2 * hour && Date.parse(value) < Date.now() + 90 * 86400000 && !busy(db, value, 30)) slots.push(value);
    }
  }
  return slots;
}
/** @param {any} db @param {any} body @param {any} user @returns {any} */
export function book(db, body, user = null) {
  const startsAt = date(body.startsAt);
  const matching = availableSlots(db, startsAt.slice(0, 10), 2);
  if (!matching.includes(startsAt)) fail(409, 'That time is no longer available. Please choose another slot.');
  let contact;
  if (user) { role(user, ['participant']); requireMember(db, user, body.cohortId); contact = { name: user.name, email: user.email }; }
  else { contact = { name: text(body.name, 100), email: email(body.email) }; if (body.consent !== true) fail(422, 'Please agree to being contacted about the call.'); }
  const token = randomBytes(32).toString('hex');
  const session = { id: id(), title: user ? `1:1 / ${contact.name}` : `Discovery / ${contact.name}`, kind: user ? 'one-to-one' : 'discovery', startsAt, duration: 30, status: 'scheduled', cohortId: user ? body.cohortId : null, participantId: user?.id || null, contact, meetingUrl: '', materials: '', summary: '', privateNotes: '', cancellationHash: hash(token), createdAt: new Date().toISOString() };
  db.sessions.push(session);
  if (!user) db.leads.push({ id: id(), ...contact, company: text(body.company, 160, false), note: text(body.message, 2000, false), stage: 'discovery', value: 0, sessionId: session.id, createdAt: new Date().toISOString() });
  notify(db, coaches(db), user ? 'A 1:1 is booked' : 'A discovery call is booked', `${contact.name} selected a 30-minute call.`, 'sessions');
  hook(db, 'calendar.event.created', { sessionId: session.id, startsAt, duration: 30 });
  return { id: session.id, startsAt, duration: 30, price: 0, token, timeZone: db.settings.timeZone, delivery: 'local' };
}
/** @param {any} db @param {any} user @param {string} action @param {any} body @returns {any} */
export function schedulingAction(db, user, action, body) {
  if (action === 'book-one-to-one') return book(db, body, user);
  if (action === 'save-session') {
    role(user);
    const session = find(db.sessions, body.id);
    const startsAt = date(body.startsAt || session.startsAt);
    const duration = number(body.duration ?? session.duration, 15, 180);
    const status = choice(body.status || session.status, ['draft', 'scheduled', 'completed', 'cancelled']);
    if(session.provider==='calendly'&&(startsAt!==session.startsAt||duration!==session.duration||(status!==session.status&&!(session.status==='scheduled'&&status==='completed'))))fail(409,'Reschedule or cancel this booking in Calendly. Preparation and private notes can be edited here.');
    if (status === 'scheduled' && busy(db, startsAt, duration, [session.id])) fail(409, 'This time overlaps another session or booking.');
    Object.assign(session, { startsAt, duration, status, title: text(body.title || session.title, 160), meetingUrl: meetingURL(body.meetingUrl), materials: text(body.materials, 10000, false), summary: text(body.summary, 20000, false), privateNotes: text(body.privateNotes, 20000, false) });
    hook(db, 'calendar.event.updated', { sessionId: session.id, startsAt, status });
    return { id: session.id };
  }
  if (action === 'cancel-session') {
    const session = find(db.sessions, body.id);
    if (user.role !== 'coach' && !(session.kind === 'one-to-one' && session.participantId === user.id)) fail(403, 'You cannot cancel this session.');
    if(session.provider==='calendly')fail(409,'Use the Calendly cancellation link in the session details.');
    if (session.status === 'completed') fail(409, 'A completed session cannot be cancelled.');
    session.status = 'cancelled'; hook(db, 'calendar.event.cancelled', { sessionId: session.id }); return {};
  }
  if (action === 'create-poll') {
    role(user); find(db.cohorts, body.cohortId);
    if (!Array.isArray(body.slots) || body.slots.length < 5 || body.slots.length > 20) fail(422, 'Provide between 5 and 20 proposed times.');
    const slots = [...new Set(body.slots.map(date))].sort();
    if (slots.length < 5 || slots.some(slot => Date.parse(slot) <= Date.now())) fail(422, 'Provide at least five distinct future times.');
    const deadline = date(body.deadline);
    if (Date.parse(deadline) <= Date.now() || Date.parse(deadline) >= Date.parse(slots[0])) fail(422, 'The deadline must be in the future and before the first proposed time.');
    const poll = { id: id(), cohortId: body.cohortId, title: text(body.title, 160), deadline, slots, responses: [], status: 'open', winningIndex: null };
    db.polls.push(poll); notify(db, participants(db, poll.cohortId), 'Choose your preferred times', poll.title, 'availability'); return { id: poll.id };
  }
  if (action === 'respond-poll') {
    role(user, ['participant']); const poll = find(db.polls, body.id); requireMember(db, user, poll.cohortId);
    if (poll.status !== 'open' || Date.parse(poll.deadline) <= Date.now()) fail(409, 'This poll is closed.');
    if (!Array.isArray(body.choices) || body.choices.length !== 5 || new Set(body.choices).size !== 5 || body.choices.some(index => !Number.isInteger(index) || index < 0 || index >= poll.slots.length)) fail(422, 'Rank exactly five different times, from your first to fifth preference.');
    poll.responses = poll.responses.filter(response => response.userId !== user.id);
    poll.responses.push({ userId: user.id, choices: body.choices, submittedAt: new Date().toISOString() }); return {};
  }
  if (action === 'confirm-poll') {
    role(user); const poll = find(db.polls, body.id); const cohort = find(db.cohorts, poll.cohortId);
    if (poll.status !== 'open') fail(409, 'This poll has already been confirmed.');
    const index = number(body.index, 0, poll.slots.length - 1);
    if (!Number.isInteger(index)) fail(422, 'Choose a proposed time.');
    const startsAt = poll.slots[index];
    if (Date.parse(startsAt) <= Date.now()) fail(409, 'Choose a future time.');
    const sessions = db.sessions.filter(item => item.cohortId === cohort.id && item.kind === 'cohort' && !['completed', 'cancelled'].includes(item.status)).sort((a,b) => a.startsAt.localeCompare(b.startsAt));
    if (!sessions.length) fail(409, 'This cohort has no sessions left to schedule.');
    const offsets = sessions.length === 6 ? [0, 2, 4, 6, 8, 11] : sessions.map((_, i) => i * 2);
    const dates = offsets.map(weeks => plusWeeks(startsAt, weeks, cohort.timeZone));
    const excludes = sessions.map(item => item.id);
    if (dates.some((value, i) => busy(db, value, sessions[i].duration, excludes))) fail(409, 'The proposed series overlaps an existing booking. Choose another time.');
    sessions.forEach((session, i) => { session.startsAt = dates[i]; session.status = 'scheduled'; });
    cohort.endDate = dates.at(-1); if (sessions.length === 6) cohort.startDate = startsAt;
    poll.status = 'confirmed'; poll.winningIndex = index;
    notify(db, participants(db, cohort.id), 'Your session schedule is confirmed', cohort.name, 'sessions');
    hook(db, 'calendar.cohort.confirmed', { cohortId: cohort.id, sessionIds: excludes }); return {};
  }
  return null;
}
/** @param {any} session @returns {string} */
export function calendarFile(session) {
  const escape = value => String(value || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, match => '\\' + match);
  const instant = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GoCoach//Coaching Platform//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT', `UID:${session.id}@gocoach.local`, `DTSTAMP:${instant(new Date())}`, `DTSTART:${instant(session.startsAt)}`, `DTEND:${instant(Date.parse(session.startsAt) + session.duration * 60000)}`, `SUMMARY:${escape(session.title)}`, `DESCRIPTION:${escape('GoCoach session. Check your workspace for materials and joining details.')}`, ...(session.meetingUrl ? [`URL:${escape(session.meetingUrl)}`] : []), `STATUS:${session.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT', 'END:VCALENDAR'];
  return lines.join('\r\n') + '\r\n';
}
