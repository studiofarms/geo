import { api } from './platform/ui.js';

const views = [['public', 'Public'], ['coach', 'Coach'], ['buyer', 'Buyer'], ['participant', 'Participant']];

/** Switch the actual demo session, preserving server-side role permissions.
 * @param {string} view @param {(path:string, body?:object)=>Promise<any>} request
 * @returns {Promise<string>} Destination after the session has changed. */
export async function changePrototypeView(view, request = api) {
  if (!views.some(([id]) => id === view)) throw new Error('Choose an available prototype view.');
  if (view === 'public') {
    try { await request('auth/logout', {}); }
    catch (error) { if (error.status !== 401) throw error; }
    return '/';
  }
  await request('auth/demo', { role: view });
  return '/portal.html#dashboard';
}

/** @param {{enabled:boolean, currentView?:string, onChange:(view:string)=>Promise<void>}} options
 * @returns {{setView:(view:string)=>void}|null} */
export function mountPrototypeSwitcher({ enabled, currentView = '', onChange }) {
  if (!enabled) return null;
  const bar = document.createElement('nav');
  bar.className = 'prototype-bar';
  bar.setAttribute('aria-label', 'Prototype views');
  bar.innerHTML = `<div class="prototype-bar-inner"><span class="prototype-label">Prototype view</span><div class="prototype-options" role="group" aria-label="Choose a prototype view">${views.map(([id, label]) => `<button type="button" data-prototype-view="${id}" aria-pressed="false">${label}</button>`).join('')}</div><span class="prototype-status" role="status" aria-live="polite"></span><p class="prototype-error" role="alert" hidden></p></div>`;
  const skip = document.querySelector('body > .skip, body > .skip-link');
  if (skip) skip.after(bar); else document.body.prepend(bar);
  document.documentElement.dataset.prototype = 'true';
  const updateHeight = () => document.documentElement.style.setProperty('--prototype-bar-height', `${bar.getBoundingClientRect().height}px`);
  new ResizeObserver(updateHeight).observe(bar);
  updateHeight();
  const buttons = [...bar.querySelectorAll('button')];
  const status = bar.querySelector('.prototype-status');
  const errorBox = bar.querySelector('.prototype-error');
  let activeView = currentView, busy = false;
  const setView = view => {
    activeView = view;
    buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.prototypeView === view)));
  };
  setView(currentView);
  bar.addEventListener('click', async event => {
    const button = event.target.closest('button[data-prototype-view]');
    if (!button || busy) return;
    const view = button.dataset.prototypeView;
    if (view === activeView && view !== 'public') return;
    busy = true;
    errorBox.hidden = true;
    bar.setAttribute('aria-busy', 'true');
    buttons.forEach(item => { item.disabled = true; });
    status.textContent = `Opening ${button.textContent} view…`;
    try {
      await onChange(view);
      setView(view);
      status.textContent = `${button.textContent} view ready.`;
    } catch (error) {
      status.textContent = '';
      errorBox.textContent = `${error.message} Please try again.`;
      errorBox.hidden = false;
    } finally {
      busy = false;
      bar.removeAttribute('aria-busy');
      buttons.forEach(item => { item.disabled = false; });
      button.focus({ preventScroll: true });
    }
  });
  return { setView };
}

async function publicPrototype() {
  try {
    const config = await api('public/config');
    mountPrototypeSwitcher({ enabled: config.demoEnabled, currentView: 'public', onChange: async view => {
      const destination = await changePrototypeView(view);
      window.location.assign(destination);
    } });
  } catch { /* The public site remains available if the prototype service is offline. */ }
}

if (typeof document !== 'undefined' && location.pathname !== '/portal.html') publicPrototype();
