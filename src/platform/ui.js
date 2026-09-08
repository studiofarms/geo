import { uuid } from '../random.js';
export const app = { data: null, route: 'dashboard', cohortId: '', refresh: null };
export const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format((cents || 0) / 100);
export const timeZone = () => app.data?.settings.timeZone || 'America/Chicago';
export const dt = (value, options = {}) => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: timeZone(), ...options }).format(new Date(value)) : 'Not scheduled';
export const time = value => dt(value, { year: undefined, month: undefined, day: undefined, hour: 'numeric', minute: '2-digit' });
export const localInput = value => { const d = new Date(value); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,16); };
export const dayKey = (value, tz = timeZone()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)).map(p => [p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
export const who = id => app.data?.users.find(user => user.id === id)?.name || 'Participant';
export const cohortName = id => app.data?.cohorts.find(cohort => cohort.id === id)?.name || 'Discovery call';
export const buyerName = id => app.data?.buyers.find(buyer => buyer.id === id)?.company || 'Your organization';
export const isCoach = () => app.data?.user.role === 'coach';
export const isBuyer = () => app.data?.user.role === 'buyer';
/** @param {any} report @returns {boolean} */
export const isCoachEvaluation = report => report.type === 'individual' && app.data?.users.some(user => user.id === report.authorId && user.role === 'coach');
export const scoped = list => (list || []).filter(item => !app.cohortId || item.cohortId === app.cohortId || item.id === app.cohortId);
const paths = { dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', pipeline: 'M4 4v16M4 7h5v5H4M10 5h5v9h-5M16 8h5v11h-5', cohorts: 'M4 7h16v14H4zM8 3v4M16 3v4M4 11h16', buyers: 'M4 21V4h11v17M15 10h5v11M8 8h3M8 12h3M8 16h3', sessions: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2', availability: 'M4 5h16v16H4zM8 2v6M16 2v6M8 14l3 3 5-6', resources: 'M3 6h7l2 3h9v11H3z', reports: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7', surveys: 'M6 4h14v17H6zM9 3h8v4H9zM9 12l2 2 5-5', billing: 'M4 5h16v14H4zM4 9h16M7 15h4', contracts: 'M5 3h14v18H5zM8 8h8M8 12h6M8 17l3-2 2 2 3-2', messages: 'M3 4h18v13H8l-5 4z', notifications: 'M6 16V9a6 6 0 0 1 12 0v7l2 2H4zM10 21h4', reminders: 'M12 3a9 9 0 1 0 8 5M19 2v6h-6M12 7v6l3 2', integrations: 'M8 3v5M16 3v5M5 8h14v3a7 7 0 0 1-7 7v4M7 8v3a5 5 0 0 0 10 0V8', arrow: 'M5 12h14M13 6l6 6-6 6', plus: 'M12 5v14M5 12h14', logout: 'M10 4H4v16h6M10 12h11M17 8l4 4-4 4' };
export const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(paths[name === 'evaluations' ? 'reports' : name] || paths.arrow).split(/(?=M)/).filter(Boolean).map(d => `<path d="${d}"/>`).join('')}</svg>`;
export const badge = status => `<span class="badge ${e(status)}">${e(String(status || 'draft').replaceAll('-', ' '))}</span>`;
export const button = (label, action, id = '', style = '') => `<button class="btn ${style}" data-action="${e(action)}" data-id="${e(id)}" type="button">${e(label)}</button>`;
export const link = (label, route, style = '') => `<a class="btn ${style}" href="#${e(route)}">${e(label)} ${icon('arrow')}</a>`;
export const empty = (title, description = '', action = '') => `<div class="empty"><span class="empty-mark">↗</span><h3>${e(title)}</h3><p>${e(description)}</p>${action}</div>`;
export const panelHead = (title, detail = '', action = '') => `<div class="panel-head"><div><h2>${e(title)}</h2>${detail ? `<p>${e(detail)}</p>` : ''}</div>${action}</div>`;
export const heading = (eyebrow, title, description = '', action = '') => `<div class="page-heading"><div><div class="eyebrow">${e(eyebrow)}</div><h1>${title}</h1>${description ? `<p>${e(description)}</p>` : ''}</div>${action}</div>`;
export const table = (headers, rows) => `<div class="table-wrap" tabindex="0" aria-label="Scrollable data table"><table><thead><tr>${headers.map(header => `<th scope="col">${e(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
export const stat = (label, value, detail = '', color = '') => `<div class="stat ${color}"><div class="eyebrow">${e(label)}</div><strong>${e(value)}</strong><span>${e(detail)}</span></div>`;
export const field = (label, name, type = 'text', value = '', extra = '', required = true) => `<label class="field"><span>${e(label)}${required ? ' <b aria-hidden="true">*</b>' : ''}</span><input name="${e(name)}" type="${type}" value="${e(value)}" ${required ? 'required' : ''} ${extra}/></label>`;
export const textarea = (label, name, value = '', required = false, extra = '') => `<label class="field"><span>${e(label)}${required ? ' *' : ''}</span><textarea name="${e(name)}" rows="4" ${required ? 'required' : ''} ${extra}>${e(value)}</textarea></label>`;
export const select = (label, name, options, value = '', extra = '') => `<label class="field"><span>${e(label)}</span><select name="${e(name)}" ${extra}>${options.map(option => { const [key, text] = Array.isArray(option) ? option : [option, option]; return `<option value="${e(key)}" ${key === value ? 'selected' : ''}>${e(text)}</option>`; }).join('')}</select></label>`;
export const check = (label, name, checked = false, required = false) => `<label class="check"><input type="checkbox" name="${e(name)}" ${checked ? 'checked' : ''} ${required ? 'required' : ''}/><span>${e(label)}</span></label>`;
export const cohortOptions = () => app.data.cohorts.map(item => [item.id, item.name]);
export const participantOptions = cohortId => app.data.enrollments.filter(item => !cohortId || item.cohortId === cohortId).map(item => [item.userId, who(item.userId)]);
export function toast(message, error = false) { const el = document.getElementById('toast'); el.textContent = message; el.classList.toggle('error', error); el.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 6000); }
export function modal(title, content, form = '') {
  const dialog = document.getElementById('modal');
  const submitLabel = { cohort:'Save cohort', buyer:'Save profile', lead:'Save opportunity', session:'Save session', invite:'Create invitation links', poll:'Open poll', 'poll-response':'Save my preferences', document:'Upload document', report:'Save report', survey:'Save survey', 'survey-response':'Submit reflection', invoice:'Create draft invoice', payment:'Record payment', contract:'Save agreement draft', acknowledgement:'Record acknowledgement', message:'Send in workspace' }[form] || 'Save changes';
  document.getElementById('modal-content').innerHTML = `<div class="modal-head"><h2 id="modal-title">${e(title)}</h2><button class="icon-btn" type="button" data-action="close-modal" aria-label="Close dialog">×</button></div>${form ? `<form data-form="${e(form)}">${content}<p class="form-error" role="alert" hidden></p><div class="modal-actions">${button('Cancel','close-modal')}<button class="btn primary" type="submit">${submitLabel} ${icon('arrow')}</button></div></form>` : content}`;
  if (!dialog.open) dialog.showModal();
}
export const closeModal = () => document.getElementById('modal').close();
export async function api(path, body, key) {
  let response;
  try { response = await fetch('/api/platform/' + path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) }); }
  catch { throw new Error('The connection was interrupted. Your entries are still here. Try again when the server is available.'); }
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'The request could not be completed.'); error.status = response.status; throw error; }
  return result;
}
export const act = async (action, payload, key = uuid()) => { const result = await api('action', { action, payload }, key); await app.refresh(); return result; };
