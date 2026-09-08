import {app,e,api,field,check,select,cohortOptions,panelHead,badge,button} from './ui.js';

export function calendlySettings() {
  const c=app.data.calendly||{};
  if(!c.available)return `<section class="panel">${panelHead('Calendly','Discovery calls and participant 1:1s')}<p class="muted-copy">Connect PostgreSQL to enable secure Calendly settings. The local sample calendar remains available for this demo.</p></section>`;
  const demo=app.data.demo;
  return `<section class="panel calendly-settings">${panelHead('Calendly','Your availability, booking confirmations, and meeting links in one place.',badge(c.connected?'connected':'not-connected'))}
    ${demo?'<div class="notice"><p>This workspace has public demo access. Configure a live Calendly account in a production workspace with coach sign-in.</p></div>':''}
    <form data-form="calendly" class="settings-form"><fieldset ${demo?'disabled':''} class="calendly-fields">
      <div class="form-grid">${field('Discovery call event link','discoveryUrl','url',c.discoveryUrl,'placeholder="https://calendly.com/your-name/discovery" list="calendly-events"',false)}${field('Participant 1:1 event link','oneToOneUrl','url',c.oneToOneUrl,'placeholder="https://calendly.com/your-name/one-to-one" list="calendly-events"',false)}</div>
      <datalist id="calendly-events">${(c.eventTypes||[]).map(event=>`<option value="${e(event.url)}">${e(event.name)} · ${e(event.duration)} minutes</option>`).join('')}</datalist>
      <p class="help">Use two separate event types. Set discovery calls to 30 minutes with no payment required in Calendly. Availability and Google / Outlook calendars are managed there.</p>
      ${field(c.tokenConfigured?'Replace personal access token (optional)':'Personal access token (optional)','token','password','','autocomplete="new-password" spellcheck="false" maxlength="4096" placeholder="Paste a Calendly personal access token"',false)}
      <p class="help">${c.tokenConfigured?'A token is securely stored. Leave this field blank to keep it.':'Event links work without a token. Add a token to verify event types and enable booking sync.'} Tokens are encrypted on the server and are never displayed here.</p>
      ${!c.secretStorageReady?'<p class="help">Your deployer must set GOCOACH_SECRET_KEY before a token can be saved.</p>':''}
      ${check('Use Calendly for discovery calls and participant 1:1s','enabled',c.enabled)}
      <div class="card-actions"><button class="btn primary" type="submit">Save & test connection</button><a class="btn quiet" href="https://calendly.com/integrations/api_webhooks" target="_blank" rel="noopener noreferrer">Get a Calendly token ↗</a></div>
      <p class="form-error" role="alert" hidden></p>
    </fieldset></form>
    <div class="calendly-sync"><div><h3>Booking sync</h3><p>${c.webhookActive?'Bookings and cancellations update GoCoach through signed Calendly webhooks.':'Enable sync to add Calendly bookings to the pipeline and session schedule automatically.'}</p>${c.accountName?`<p class="help">Connected as ${e(c.accountName)} · ${e(c.accountEmail)}</p>`:''}${!c.webhookRegistrationAllowed?'<p class="help">Webhook changes are available on the production site.</p>':''}<p class="help">Your token needs user, event type, and scheduled event read access plus webhook write access. Webhook access depends on your Calendly plan.</p>${c.unmatchedBookings?`<p class="notice">${e(c.unmatchedBookings)} booking(s) need review in Calendly. Check for schedule conflicts and that participants used their cohort link and account email.</p>`:''}</div><div class="card-actions">${!demo&&c.tokenConfigured&&!c.webhookActive&&c.webhookRegistrationAllowed?button('Enable booking sync','calendly-webhook','','primary'):''}${c.webhookActive?badge('active'):badge('not-connected')}${!demo&&(c.tokenConfigured||c.enabled)?button('Disconnect','calendly-disconnect','','quiet danger'):''}</div></div>
  </section>`;
}

/** Calendly owns the booking form. Only signed webhooks confirm a session in GoCoach. */
export async function mountCalendlyBooking(container,{participant=false,cohortId='',config={}}={}) {
  let chosen=cohortId||app.cohortId||app.data?.cohorts[0]?.id||'',version=0;
  container.innerHTML=`<div class="booking-heading"><span class="eyebrow">${participant?'A little space, just for you':'Your first conversation'}</span><h2>${participant?'Book a <em>1:1.</em>':'Let’s find <em>a time.</em>'}</h2><p>${participant?'Choose your cohort and book using your GoCoach account email.':'A free, 30-minute discovery call with Carol Anthony.'}</p></div>${participant?select('Your cohort','calendlyCohort',cohortOptions(),chosen):''}<div class="calendly-booking" aria-live="polite"></div>`;
  const content=container.querySelector('.calendly-booking');
  const load=async()=>{
    const current=++version;content.innerHTML='<p class="loading-copy" role="status">Opening Calendly…</p>';
    try {
      if(participant&&!chosen)throw new Error('Enroll in a cohort before booking a 1:1.');
      if(participant&&!config.oneToOneEnabled)throw new Error('Your coach has not enabled 1:1 booking yet.');
      const url=new URL(participant?(await api('calendly/booking-link',{cohortId:chosen})).url:config.discoveryUrl);
      if(url.origin!=='https://calendly.com')throw new Error('This booking link is unavailable. Please contact your coach.');
      const external=url.href;url.searchParams.set('embed_domain',location.hostname);url.searchParams.set('embed_type','Inline');
      if(current!==version||!container.isConnected)return;
      content.innerHTML=`<p class="help">Complete your booking below. ${config.webhookActive?'Your session will appear in GoCoach once Calendly confirms it.':'Calendly will confirm your booking; automatic GoCoach sync is not enabled yet.'}</p><a class="btn quiet" href="${e(external)}" target="_blank" rel="noopener noreferrer">Open Calendly in a new tab ↗</a><iframe class="calendly-frame" title="${participant?'Book a participant 1:1':'Book a discovery call'} with Calendly" src="${e(url.href)}" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    }catch(error){if(current===version)content.innerHTML=`<p class="form-error" role="alert">${e(error.message)}</p><button type="button" class="btn" data-calendly-retry>Try again</button>`;}
  };
  container.addEventListener('change',event=>{if(event.target.name==='calendlyCohort'){chosen=event.target.value;load();}});
  container.addEventListener('click',event=>{if(event.target.closest('[data-calendly-retry]'))load();});
  await load();
}
