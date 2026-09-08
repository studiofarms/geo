import { app, e, dt, time, dayKey, api, money, field, textarea, check, select, icon, cohortOptions } from './ui.js';
import { uuid } from '../random.js';
import { mountCalendlyBooking } from './calendly.js';
/** A shared calendar picker for public discovery calls and authenticated participant 1:1s. */
export async function mountBooking(container, { participant = false, cohortId = '' } = {}) {
  container.innerHTML='<p class="loading-copy" role="status">Loading booking options…</p>';
  let configuration;
  try { configuration=await api('public/config'); }
  catch(error){container.innerHTML=`<p class="form-error" role="alert">${e(error.message)}</p>`;return;}
  if(configuration.calendly?.enabled)return mountCalendlyBooking(container,{participant,cohortId,config:configuration.calendly});
  if(configuration.storage==='postgres'&&!configuration.demoEnabled){container.innerHTML='<p class="notice">Booking will open when your coach connects Calendly.</p><a class="btn" href="/index.html#inquiry">Contact Carol ↗</a>';return;}
  const now=new Date();let month=new Date(now.getFullYear(),now.getMonth(),1),slots=[],zone='America/Chicago',selectedDay='',selectedSlot='',busy=false,contact={},chosenCohort=cohortId||app.cohortId||app.data?.cohorts[0]?.id||'',requestId=uuid(),lastPayload='';
  const today=()=>dayKey(new Date(),zone);
  const dateLabel=value=>new Intl.DateTimeFormat('en-US',{dateStyle:'full',timeZone:zone}).format(new Date(value));
  const timeLabel=value=>new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:zone}).format(new Date(value));
  const render=()=>{
    const monthKey=`${month.getFullYear()}-${String(month.getMonth()+1).padStart(2,'0')}`;
    const count=new Date(month.getFullYear(),month.getMonth()+1,0).getDate();
    const cells=Array.from({length:month.getDay()},()=>'<span></span>');
    for(let day=1;day<=count;day++){
      const key=`${monthKey}-${String(day).padStart(2,'0')}`,has=slots.some(slot=>dayKey(slot,zone)===key);
      cells.push(`<button type="button" data-day="${key}" aria-label="${e(new Date(key+'T12:00:00').toLocaleDateString('en-US',{dateStyle:'full'}))}" aria-pressed="${key===selectedDay}" ${!has?'disabled':''} class="${key===selectedDay?'selected':''}">${day}</button>`);
    }
    const times=slots.filter(slot=>dayKey(slot,zone)===selectedDay);
    container.innerHTML=`<div class="booking-heading"><span class="eyebrow">${participant?'A little space, just for you':'Your first conversation'}</span><h2>${participant?'Book a <em>1:1.</em>':'Let’s find <em>a time.</em>'}</h2><div class="booking-specs"><span>${icon('sessions')}30 minutes</span><span>${participant?'No payment collected':'$0 · Discovery call'}</span><span>Carol Anthony, M.S., PCC</span></div></div><div class="booking-layout"><div class="calendar"><div class="calendar-heading"><button class="icon-btn" data-month="-1" aria-label="Previous month" ${month.getFullYear()===now.getFullYear()&&month.getMonth()===now.getMonth()?'disabled':''}>←</button><h3>${e(month.toLocaleDateString('en-US',{month:'long',year:'numeric'}))}</h3><button class="icon-btn" data-month="1" aria-label="Next month" ${month.getTime()>Date.now()+60*86400000?'disabled':''}>→</button></div><div class="calendar-week">${['Su','Mo','Tu','We','Th','Fr','Sa'].map(d=>`<span>${d}</span>`).join('')}</div><div class="calendar-days">${cells.join('')}</div><p class="help">Times shown in ${e(zone)}. Availability is checked again when you book.</p></div><div class="time-picker"><h3>${selectedDay?e(new Date(selectedDay+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})):'Choose an available date'}</h3><div class="time-slots">${times.map(slot=>`<button type="button" class="time-slot ${selectedSlot===slot?'selected':''}" data-slot="${e(slot)}" aria-pressed="${selectedSlot===slot}">${timeLabel(slot)}</button>`).join('')||'<p class="help">No times on this date. Select another date or month.</p>'}</div></div></div><form class="booking-form">${participant?select('Your cohort','cohortId',cohortOptions(),chosenCohort):`<div class="form-grid">${field('Your name','name','text',contact.name||'','autocomplete="name" maxlength="100"')}${field('Email address','email','email',contact.email||'','autocomplete="email" maxlength="254"')}${field('Company (optional)','company','text',contact.company||'','maxlength="160"',false)}</div>${textarea('Anything you’d like Carol to know? (optional)','message',contact.message||'',false,'maxlength="2000"')}${check('I agree to being contacted about this discovery call.','consent',contact.consent,false)}<div class="honeypot" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off" aria-label="Leave empty"/></div>`}<div class="booking-footer"><p>${selectedSlot?`<strong>${e(dateLabel(selectedSlot))}</strong><br/>${timeLabel(selectedSlot)} · ${e(zone)}`:'Select a date and time to continue.'}</p><button type="submit" class="btn primary" ${!selectedSlot?'disabled':''}>${participant?'Book this 1:1':'Book free discovery call'} ${icon('arrow')}</button></div><p class="form-error" role="alert" hidden></p><p class="help">Your booking is saved on this local server. No confirmation email is sent; calendar account sync is not connected.</p></form>`;
  };
  const load=async()=>{
    container.innerHTML='<p class="loading-copy" role="status">Finding available times…</p>';
    const start=`${month.getFullYear()}-${String(month.getMonth()+1).padStart(2,'0')}-01`;
    try{
      const result=await api(`public/slots?from=${start<today()?today():start}&days=31`); slots=result.slots;zone=result.timeZone;
      const monthKey=start.slice(0,7),visible=slots.filter(slot=>dayKey(slot,zone).startsWith(monthKey));
      if(!visible.some(slot=>dayKey(slot,zone)===selectedDay))selectedDay=visible.length?dayKey(visible[0],zone):'';
      selectedSlot='';render();
    }catch(error){container.innerHTML=`<p class="form-error" role="alert">${e(error.message)}</p><button class="btn" data-retry>Try again</button>`;}
  };
  const remember=()=>{const form=container.querySelector('.booking-form');if(form){contact={...Object.fromEntries(new FormData(form)),consent:!!form.elements.consent?.checked};chosenCohort=form.elements.cohortId?.value||chosenCohort;}};
  container.addEventListener('click',async event=>{
    const target=event.target.closest('button');if(!target||busy)return;
    if(target.dataset.month){remember();month=new Date(month.getFullYear(),month.getMonth()+Number(target.dataset.month),1);await load();}
    if(target.dataset.day){remember();selectedDay=target.dataset.day;selectedSlot='';render();}
    if(target.dataset.slot){remember();selectedSlot=target.dataset.slot;render();}
    if(target.hasAttribute('data-retry'))await load();
    if(target.dataset.cancel){
      target.disabled=true;
      try{await api('public/cancel-booking',{token:target.dataset.cancel});container.querySelector('.booking-confirmation').innerHTML='<h2>Booking cancelled.</h2><p>Your time has been released. You can choose another time whenever you are ready.</p><a class="btn primary" href="/book.html">Choose another time</a>';if(participant)await app.refresh();}
      catch(error){target.disabled=false;const message=container.querySelector('[role="alert"]');message.textContent=error.message;message.hidden=false;}
    }
  });
  container.addEventListener('submit',async event=>{
    const form=event.target;if(!form.matches('.booking-form'))return;
    event.preventDefault();event.stopPropagation();if(busy||!selectedSlot||!form.reportValidity())return;
    remember();busy=true;const submit=form.querySelector('[type=submit]'),errorBox=form.querySelector('.form-error');submit.disabled=true;submit.textContent='Reserving your time…';errorBox.hidden=true;
    try{
      const body={...contact,cohortId:chosenCohort,startsAt:selectedSlot};
      const fingerprint=JSON.stringify(body);
      if(lastPayload!==fingerprint){requestId=uuid();lastPayload=fingerprint;}
      body.requestId=requestId;
      const result=participant?await api('action',{action:'book-one-to-one',payload:body},requestId):await api('public/book',body);
      container.innerHTML=`<section class="booking-confirmation" tabindex="-1"><span class="confirmation-mark">✓</span><span class="eyebrow">A first step, taken.</span><h2>Your time is <em>reserved.</em></h2><p>${e(dateLabel(result.startsAt))}<br/><strong>${timeLabel(result.startsAt)} · ${e(zone)}</strong><br/>30 minutes with Carol Anthony</p><p class="notice">Saved in the local GoCoach calendar. No email has been sent and no external calendar has been updated.</p><div class="card-actions"><a class="btn primary" href="/api/platform/public/booking-calendar?token=${e(result.token)}">Add to calendar (.ics) ↓</a>${participant?'<a class="btn" href="/portal.html#sessions">My sessions</a>':'<a class="btn" href="/">Back to GoCoach</a>'}</div><button class="btn quiet danger" data-cancel="${e(result.token)}">Cancel this booking</button><p class="form-error" role="alert" hidden></p></section>`;
      container.querySelector('.booking-confirmation').focus();if(participant)await app.refresh();
    }catch(error){errorBox.hidden=false;errorBox.textContent=error.message;submit.disabled=false;submit.textContent='Try booking again';}
    finally{busy=false;}
  });
  await load();
}
