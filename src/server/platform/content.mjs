import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { id, fail, text, date, choice, role, find, member, requireMember, participants, notify } from './core.mjs';
/** @param {any} db @param {any} user @param {any} document @returns {boolean} */
export function documentAccess(db, user, document) {
  if (document.archived) return false;
  if (user.role === 'coach') return true;
  if (!member(db, user, document.cohortId)) return false;
  if (document.scope === 'private') return false;
  if (document.scope === 'individual') return document.participantId === user.id;
  if (document.scope === 'buyer') return user.role === 'buyer';
  return document.scope === 'cohort';
}
/** @param {any} db @param {any} user @param {any} report @returns {boolean} */
export function reportAccess(db, user, report) {
  if (user.role === 'coach') return true;
  if (!member(db, user, report.cohortId)) return false;
  if (user.role === 'participant') return report.type === 'individual' && report.participantId === user.id && (report.status === 'published' || report.authorId === user.id);
  return report.status === 'published' && (report.type !== 'individual' || report.shareBuyer === true);
}
/** @param {any} db @param {any} user @param {string} action @param {any} body @param {string} directory @param {boolean} database @returns {Promise<any>} */
export async function contentAction(db, user, action, body, directory, database = false) {
  if (action === 'upload-document') {
    role(user); find(db.cohorts, body.cohortId);
    const scope = choice(body.scope, ['cohort', 'individual', 'buyer', 'private']);
    if (scope === 'individual' && !db.enrollments.some(item => item.cohortId === body.cohortId && item.userId === body.participantId)) fail(422, 'Choose a participant in this cohort.');
    const originalName = text(body.filename, 180).replace(/[\\/<>:"|?*]/g, '_');
    const extension = originalName.split('.').at(-1).toLowerCase();
    const allowed = { pdf: 'application/pdf', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };
    if (!allowed[extension] || typeof body.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) fail(422, 'Upload a PDF, TXT, DOCX, XLSX, PNG, or JPG file.');
    const bytes = Buffer.from(body.base64, 'base64');
    if (!bytes.length || bytes.length > 3 * 1024 * 1024) fail(413, 'Files must be between 1 byte and 3 MB.');
    if (extension === 'pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') fail(422, 'This does not appear to be a valid PDF.');
    if (['docx', 'xlsx'].includes(extension) && bytes.subarray(0, 2).toString() !== 'PK') fail(422, 'This does not appear to be a valid Office document.');
    const document = { id: id(), title: text(body.title, 160), cohortId: body.cohortId, scope, participantId: scope === 'individual' ? body.participantId : null, sessionId: body.sessionId || null, phase: choice(body.phase || 'resource', ['resource', 'before', 'after']), originalName, mime: allowed[extension], size: bytes.length, createdAt: new Date().toISOString(), archived: false };
    if (document.sessionId && find(db.sessions, document.sessionId).cohortId !== document.cohortId) fail(422, 'The selected session belongs to another cohort.');
    document.uploadedBy = user.id;
    if (database) { db.pendingFiles ||= []; db.pendingFiles.push({id:document.id,base64:bytes.toString('base64')}); }
    else {
      await mkdir(join(directory, 'files'), { recursive: true, mode: 0o700 });
      await writeFile(join(directory, 'files', document.id), bytes, { mode: 0o600, flag: 'wx' });
    }
    db.documents.push(document);
    const recipients = db.users.filter(account => account.role !== 'coach' && documentAccess(db, account, document)).map(account => account.id);
    notify(db, recipients, 'A resource has been shared', document.title, 'resources'); return { id: document.id };
  }
  if (action === 'archive-document') { role(user); find(db.documents, body.id).archived = true; return {}; }
  if (action === 'save-report') {
    role(user, ['coach', 'participant']); requireMember(db, user, body.cohortId);
    const existing = body.id ? find(db.reports, body.id) : null;
    if (user.role !== 'coach' && existing && existing.authorId !== user.id) fail(403, 'You can only edit your own reflections.');
    const type = user.role === 'participant' ? 'individual' : choice(body.type, ['individual', 'cohort', 'end-of-program']);
    const participantId = type === 'individual' ? (user.role === 'participant' ? user.id : body.participantId) : null;
    if (type === 'individual' && !db.enrollments.some(item => item.cohortId === body.cohortId && item.userId === participantId)) fail(422, 'Choose a participant in this cohort.');
    const report = existing || { id: id(), authorId: user.id, createdAt: new Date().toISOString() };
    const status = choice(body.status, ['draft', 'published']);
    Object.assign(report, { cohortId: body.cohortId, participantId, type, title: text(body.title, 180), highlights: text(body.highlights, 10000), progress: text(body.progress, 10000, false), nextSteps: text(body.nextSteps, 10000, false), shareBuyer: body.shareBuyer === true, status, updatedAt: new Date().toISOString() });
    if (!existing) db.reports.push(report);
    if (status === 'published') {
      report.publishedAt = new Date().toISOString();
      notify(db, db.users.filter(account => account.id !== user.id && reportAccess(db, account, report)).map(account => account.id), 'A report has been shared', report.title, 'reports');
    }
    return { id: report.id };
  }
  if (action === 'save-survey') {
    role(user); find(db.cohorts, body.cohortId);
    if (!Array.isArray(body.questions) || !body.questions.length || body.questions.length > 10) fail(422, 'Add between 1 and 10 rating questions.');
    const questions = body.questions.map(question => text(question, 300));
    const survey = body.id ? find(db.surveys, body.id) : { id: id(), responses: [] };
    const stage = choice(body.stage, ['pre', 'mid', 'post']);
    if (survey.responses.length && (JSON.stringify(questions) !== JSON.stringify(survey.questions) || body.cohortId !== survey.cohortId || stage !== survey.stage)) fail(409, 'Questions, cohort, and stage cannot change after responses arrive.');
    Object.assign(survey, { title: text(body.title, 160), cohortId: body.cohortId, stage, deadline: date(body.deadline), status: choice(body.status, ['draft', 'open', 'closed']), questions });
    if (!body.id) db.surveys.push(survey);
    if (survey.status === 'open') notify(db, participants(db, survey.cohortId), 'A reflection survey is open', survey.title, 'surveys');
    return { id: survey.id };
  }
  if (action === 'respond-survey') {
    role(user, ['participant']); const survey = find(db.surveys, body.id); requireMember(db, user, survey.cohortId);
    if (survey.status !== 'open' || Date.parse(survey.deadline) < Date.now()) fail(409, 'This survey is closed.');
    if (!Array.isArray(body.answers) || body.answers.length !== survey.questions.length || body.answers.some(answer => !Number.isInteger(answer) || answer < 1 || answer > 5)) fail(422, 'Answer every question on a scale of 1 to 5.');
    survey.responses = survey.responses.filter(response => response.userId !== user.id);
    survey.responses.push({ userId: user.id, answers: body.answers, reflection: text(body.reflection, 5000, false), submittedAt: new Date().toISOString() }); return {};
  }
  return null;
}
