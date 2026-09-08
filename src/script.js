import { uuid } from './random.js';
import './prototype.js';
/* Progressive enhancement: navigation, inquiry submission, and restrained motion. */
(() => {
  'use strict';
  document.documentElement.classList.add('enhanced');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  document.querySelectorAll('[data-year]').forEach(element => { element.textContent = new Date().getFullYear(); });

  const menu = document.querySelector('.menu-toggle');
  const navigation = document.querySelector('#primary-navigation');
  if (menu && navigation) {
    menu.hidden = false;
    const setMenu = (open, restoreFocus = false) => {
      menu.setAttribute('aria-expanded', String(open));
      menu.innerHTML = open ? 'Close <span aria-hidden="true">×</span>' : 'Menu <span aria-hidden="true">☰</span>';
      navigation.classList.toggle('is-open', open);
      if (restoreFocus) menu.focus();
    };
    menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
    navigation.addEventListener('click', event => { if (event.target.closest('a')) setMenu(false); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') setMenu(false, true);
    });
    document.addEventListener('click', event => { if (!event.target.closest('.top')) setMenu(false); });
    window.matchMedia('(min-width: 981px)').addEventListener('change', () => setMenu(false));
    const sections = [...navigation.querySelectorAll('a[href^="#"]')].map(link => ({ link, section: document.querySelector(link.hash) }));
    let ticking = false;
    const updateActive = () => {
      let active = null;
      for (const entry of sections) if (entry.section?.getBoundingClientRect().top <= 150) active = entry.link;
      for (const { link } of sections) {
        if (link === active) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
      ticking = false;
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(updateActive); } }, { passive: true });
    updateActive();
  }

  const form = document.querySelector('#inquiry-form');
  if (form) {
    const status = document.querySelector('#form-status');
    const submit = form.querySelector('[type="submit"]');
    const success = document.querySelector('#form-success');
    const fieldNames = ['name', 'email', 'organization', 'interest', 'message', 'consent'];
    let pending = false;
    let requestKey;
    let lastPayload;
    const fieldError = (name, message) => {
      if (!fieldNames.includes(name)) return;
      const input = form.elements.namedItem(name);
      document.getElementById(`${name}-error`).textContent = message;
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    };
    for (const name of fieldNames) {
      const input = form.elements.namedItem(name);
      input.addEventListener('input', () => fieldError(name, ''));
      input.addEventListener('invalid', () => fieldError(name, input.validationMessage));
    }
    const message = form.elements.namedItem('message');
    message.addEventListener('input', () => {
      document.getElementById('message-hint').textContent = `${message.value.length.toLocaleString()} / 2,000 characters`;
    });
    document.querySelectorAll('[data-interest]').forEach(link => link.addEventListener('click', () => {
      if (form.hidden) {
        success.hidden = true;
        form.hidden = false;
      }
      form.elements.namedItem('interest').value = link.dataset.interest;
      form.elements.namedItem('name').focus({ preventScroll: true });
    }));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending) return;
      fieldNames.forEach(name => fieldError(name, ''));
      for (const name of ['name', 'email', 'organization']) form.elements.namedItem(name).value = form.elements.namedItem(name).value.trim();
      if (!form.reportValidity()) return;
      const data = Object.fromEntries(new FormData(form));
      data.consent = form.elements.namedItem('consent').checked;
      const serialized = JSON.stringify(data);
      if (serialized !== lastPayload) { requestKey = uuid(); lastPayload = serialized; }
      pending = true;
      submit.disabled = true;
      form.setAttribute('aria-busy', 'true');
      submit.firstElementChild.textContent = 'Saving inquiry…';
      status.classList.remove('is-error');
      status.textContent = 'Saving your inquiry…';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch('/api/inquiries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': requestKey },
          body: serialized,
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) {
          for (const [name, error] of Object.entries(result.fields || {})) fieldError(name, error);
          throw new Error(result.error || 'We could not save your inquiry. Please try again.');
        }
        document.getElementById('receipt-name').textContent = data.name;
        document.getElementById('receipt-reference').textContent = result.reference;
        form.hidden = true;
        success.hidden = false;
        success.focus({ preventScroll: true });
        success.scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'center' });
      } catch (error) {
        status.classList.add('is-error');
        status.textContent = error.name === 'AbortError' || error instanceof TypeError
          ? 'The connection was interrupted. Your details are still here. Please try again; the same inquiry will only be saved once.'
          : error.message;
        const invalid = form.querySelector('[aria-invalid="true"]');
        (invalid || status).focus();
      } finally {
        clearTimeout(timeout);
        pending = false;
        submit.disabled = false;
        form.removeAttribute('aria-busy');
        submit.firstElementChild.textContent = 'Submit inquiry';
        if (form.hidden) status.textContent = '';
      }
    });
    form.noValidate = true;
    document.getElementById('new-inquiry').addEventListener('click', () => {
      form.reset();
      requestKey = undefined;
      lastPayload = undefined;
      fieldNames.forEach(name => fieldError(name, ''));
      status.textContent = '';
      document.getElementById('message-hint').textContent = 'Up to 2,000 characters';
      success.hidden = true;
      form.hidden = false;
      form.elements.namedItem('name').focus();
    });
  }

  document.querySelectorAll('[data-print]').forEach(button => {
    button.hidden = false;
    button.addEventListener('click', () => window.print());
  });

  if (reducedMotion.matches || !('IntersectionObserver' in window)) return;
  const revealObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      entry.target.classList.add('in');
      revealObserver.unobserve(entry.target);
    }
  }, { threshold: 0.05 });
  document.querySelectorAll('.reveal').forEach(element => {
    if (element.getBoundingClientRect().top > window.innerHeight) {
      element.classList.add('reveal-ready');
      revealObserver.observe(element);
    }
  });
  const arcObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      requestAnimationFrame(() => entry.target.querySelectorAll('path').forEach(path => { path.style.strokeDashoffset = 0; }));
      arcObserver.unobserve(entry.target);
    }
  }, { threshold: 0.1 });
  document.querySelectorAll('.velocity-arc').forEach(svg => {
    svg.querySelectorAll('path').forEach((path, index) => {
      const length = path.getTotalLength();
      path.style.strokeDasharray = length;
      path.style.strokeDashoffset = length;
      path.style.transition = `stroke-dashoffset 1.6s ${index * .08}s cubic-bezier(.22,.61,.36,1)`;
    });
    arcObserver.observe(svg);
  });
  reducedMotion.addEventListener('change', event => {
    if (!event.matches) return;
    revealObserver.disconnect();
    arcObserver.disconnect();
    document.querySelectorAll('.reveal-ready').forEach(element => element.classList.add('in'));
    document.querySelectorAll('.velocity-arc path').forEach(path => { path.style.strokeDashoffset = 0; });
  });
})();
