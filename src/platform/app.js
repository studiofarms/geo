import { app, e, api, act, icon, field, button, empty, modal, closeModal, toast, participantOptions, isCoach } from './ui.js';
import * as views from './views.js';
import * as operations from './operations-views.js';
import * as forms from './forms.js';
import * as operationForms from './operations-forms.js';
import { submit, showInvitations } from './submissions.js';
import { mountBooking } from './booking.js';
import { mountPrototypeSwitcher, changePrototypeView } from '../prototype.js';
const root=document.getElementById('app');
let config={demoEnabled:false}, authEpoch=0, refreshQueue=Promise.resolve(), prototypeSwitcher=null;
const navigation=[
  ['dashboard','Overview',['coach','buyer','participant']],['pipeline','Client pipeline',['coach']],['cohorts','Cohorts',['coach','buyer','participant']],['buyers','Buyer accounts',['coach','buyer']],['sessions','Sessions',['coach','buyer','participant']],['availability','Availability',['coach','buyer','participant']],['resources','Resources',['coach','buyer','participant']],['reports','Reports',['coach','buyer','participant']],['evaluations','Evaluations',['coach','buyer']],['surveys','Surveys',['coach','buyer','participant']],['billing','Billing & revenue',['coach','buyer']],['contracts','Agreements',['coach','buyer']],['messages','Messages',['coach','buyer','participant']],['notifications','Notifications',['coach','buyer','participant']],['reminders','Reminders',['coach']],['integrations','Settings',['coach']],
];
function login(error='') {
  prototypeSwitcher?.setView('');
  document.body.classList.remove('menu-active');
  root.innerHTML=`<main id="main" class="login-page"><section class="login-story"><a class="brand brand-wide" href="/"><img class="brand-logo" src="/assets/gocoach-lockup.svg" alt="GoCoach" width="306" height="42"/></a><span class="eyebrow">Your coaching workspace</span><h1>A practice<br/>for <em>forward</em><br/>motion.</h1><p>The people, conversations, and small commitments that keep the work moving.</p><a href="/">← Back to the practice</a></section><section class="login-panel"><div class="eyebrow">Welcome to your workspace</div><h2>Welcome back</h2><p>Sign in to manage your coaching journey.</p><form data-form="login">${field('Email address','email','email','','autocomplete="username"')}${field('Password','password','password','','autocomplete="current-password"')}<button class="btn primary full" type="submit">Sign in ${icon('arrow')}</button><p class="form-error" role="alert" ${error?'':'hidden'}>${e(error)}</p></form><p class="help">Joining a cohort? Create your account using the invitation link from your coach.</p>${config.demoEnabled?`<div class="demo-roles"><span class="eyebrow">Explore with sample data</span><p>Explore the workspace from each perspective.</p><div>${['coach','buyer','participant'].map(role=>`<button class="demo-role ${role}" data-action="demo-${role}">${icon(role==='coach'?'dashboard':role==='buyer'?'buyers':'cohorts')}<strong>${role[0].toUpperCase()+role.slice(1)}</strong><span>Open workspace ↗</span></button>`).join('')}</div><small>Demo access is available only on the local development server.</small></div>`:''}</section></main>`;
}
async function invitation(token) {
  try {
    const invitation=await api('public/invitation?token='+encodeURIComponent(token));
    root.innerHTML=`<main id="main" class="invitation-page"><a class="brand" href="/"><img class="brand-logo" src="/assets/gocoach-logo.svg" alt="GoCoach" width="178" height="37"/></a><div class="login-panel"><span class="eyebrow">An invitation to move forward</span><h1>Welcome to<br/><em>${e(invitation.cohortName)}.</em></h1><p>${e(invitation.email)}</p><form data-form="accept"><input type="hidden" name="token" value="${e(token)}"/>${field('Your full name','name','text',invitation.name,'autocomplete="name"')}${field(invitation.existingAccount?'Your existing password':'Create a password','password','password','','minlength="12" maxlength="128" autocomplete="new-password"')}<p class="help">${invitation.existingAccount?'This email already has an account. Use its current password to accept.':'Use at least 12 characters. This invitation can only be accepted once.'}</p><button class="btn primary full" type="submit">Accept invitation ${icon('arrow')}</button><p class="form-error" role="alert" hidden></p></form></div></main>`;
  } catch(error) { root.innerHTML=`<main class="loading" id="main"><a class="brand" href="/"><img class="brand-logo" src="/assets/gocoach-logo.svg" alt="GoCoach" width="178" height="37"/></a>${empty('This invitation is unavailable',error.message,'<a class="btn primary" href="/portal.html">Go to sign in</a>')}</main>`; }
}
const navSections = [
  ['Workspace', ['dashboard', 'pipeline', 'cohorts', 'buyers']],
  ['Coaching', ['sessions', 'availability', 'resources', 'evaluations', 'reports', 'surveys']],
  ['Operations', ['billing', 'contracts', 'reminders', 'integrations']],
  ['Communication', ['messages', 'notifications']],
];
/** @param {boolean} open @param {boolean} restoreFocus */
function setMenu(open, restoreFocus = true) {
  const workspace = document.querySelector('.workspace');
  if (!workspace) return;
  open = open && window.matchMedia('(max-width:850px)').matches;
  workspace.classList.toggle('menu-open', open);
  document.body.classList.toggle('menu-active', open);
  workspace.querySelector('.workspace-main').inert = open;
  const sidebar = workspace.querySelector('.sidebar');
  sidebar.inert = !open && window.matchMedia('(max-width:850px)').matches;
  document.querySelector('.mobile-menu')?.setAttribute('aria-expanded', String(open));
  if (open) sidebar.querySelector('a[aria-current]')?.focus();
  else if (restoreFocus) document.querySelector('.mobile-menu')?.focus();
}
function render() {
  if(!app.data)return login();
  const d=app.data,user=d.user,route=location.hash.slice(1)||'dashboard';
  prototypeSwitcher?.setView(user.role);
  app.route=route;
  const key=route.startsWith('cohort/')?'cohorts':route;
  const allowed=navigation.filter(item=>item[2].includes(user.role));
  const current=allowed.find(item=>item[0]===key);
  if(!current){history.replaceState(null,'','#dashboard');return render();}
  if(app.cohortId&&!d.cohorts.some(c=>c.id===app.cohortId))app.cohortId='';
  const unread=d.notifications.filter(n=>!n.read).length;
  const view=route.startsWith('cohort/')?views.cohortDetail(route.split('/')[1]):({...views,...operations, dashboard:views.overview}[key])();
  root.innerHTML=`<div class="workspace"><aside class="sidebar" id="workspace-navigation" aria-label="Workspace navigation"><button class="icon-btn sidebar-close" data-action="toggle-menu" aria-label="Close navigation">×</button><a class="brand" href="/"><img class="brand-logo" src="/assets/gocoach-logo.svg" alt="GoCoach" width="178" height="37"/></a><div class="workspace-label">${e(user.role)} workspace</div><nav aria-label="Main navigation">${navSections.map(([group,ids])=>{const links=allowed.filter(([id])=>ids.includes(id));return links.length?`<div class="nav-group"><div class="nav-label">${group}</div>${links.map(([id,label])=>`<a href="#${id}" ${key===id?'aria-current="page"':''}>${icon(id)}<span>${user.role==='buyer'&&id==='buyers'?'Company profile':user.role==='buyer'&&id==='billing'?'Invoices & payments':label}</span>${id==='notifications'&&unread?`<span class="count">${unread}</span>`:''}</a>`).join('')}</div>`:'';}).join('')}</nav><div class="sidebar-foot"><span class="avatar">${e(user.name.split(' ').map(w=>w[0]).slice(0,2).join(''))}</span><div><strong>${e(user.name)}</strong><span>${e(user.role)}</span></div><button class="icon-btn" data-action="logout" aria-label="Sign out">${icon('logout')}</button></div></aside><button class="menu-backdrop" type="button" data-action="close-menu" aria-label="Close navigation" tabindex="-1"></button><div class="workspace-main"><header class="workspace-header"><button class="icon-btn mobile-menu" data-action="toggle-menu" aria-label="Toggle workspace menu" aria-controls="workspace-navigation" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><div class="breadcrumb"><a href="#dashboard">Workspace</a><span aria-hidden="true">/</span>${e(current[1])}</div><div class="header-actions"><label class="cohort-filter" ${route.startsWith('cohort/')||['pipeline','buyers','messages','notifications','reminders','integrations'].includes(key)?'hidden':''}><span class="sr-only">Filter by cohort</span><select id="cohort-filter"><option value="">All cohorts</option>${d.cohorts.map(c=>`<option value="${e(c.id)}" ${c.id===app.cohortId?'selected':''}>${e(c.name)}</option>`).join('')}</select></label><a class="icon-btn" href="#notifications" aria-label="${unread} unread notifications">${icon('notifications')}${unread?'<span class="notification-dot"></span>':''}</a></div></header>${d.demo?'<div class="demo-banner"><span class="tiny-dot orange"></span><strong>Demo workspace</strong><span>Sample data · public prototype access</span><a href="/">Public website ↗</a></div>':''}<main class="workspace-content" id="main" tabindex="-1">${view}</main><footer class="workspace-footer"><span>GoCoach · Leadership in practice.</span><span>Private workspace · ${e(user.role)} access</span></footer></div></div>`;
  setMenu(false, false);
}
app.refresh=()=>{
  const epoch=authEpoch;
  const refresh=refreshQueue.then(async()=>{
    if(epoch!==authEpoch)return;
    try{const data=await api('state');if(epoch!==authEpoch)return;app.data=data;render();}
    catch(error){if(epoch!==authEpoch)return;if(error.status===401){app.data=null;login();}else throw error;}
  });
  refreshQueue=refresh.catch(()=>{});
  return refresh;
};
async function signIn(path,body){authEpoch++;await api(path,body);history.replaceState(null,'','/portal.html#dashboard');app.cohortId='';await app.refresh();}

async function switchPrototypeView(view) {
  authEpoch++;
  setMenu(false, false);
  closeModal();
  root.inert = true;
  try {
    const destination = await changePrototypeView(view);
    if (view === 'public') { window.location.assign(destination); return; }
    authEpoch++;
    app.data = null;
    app.cohortId = '';
    history.replaceState(null, '', destination);
    await app.refresh();
    if (app.data?.user.role !== view) throw new Error('The workspace could not be opened.');
  } catch (error) {
    try { await app.refresh(); } catch { app.data = null; login(error.message); }
    throw error;
  } finally { root.inert = false; }
}

const simple={
  'new-cohort':()=>forms.cohortForm(), 'edit-cohort':forms.cohortForm,
  'new-buyer':()=>forms.buyerForm(), 'edit-buyer':forms.buyerForm, 'bulk-invite':forms.inviteForm,
  'new-lead':()=>forms.leadForm(), 'edit-lead':forms.leadForm,
  'edit-session':forms.sessionForm, 'session-detail':forms.sessionDetail,
  'new-poll':forms.pollForm, 'respond-poll':forms.respondPoll, 'poll-matrix':forms.pollMatrix,
  'upload-document':forms.documentForm,'new-report':()=>forms.reportForm(),'edit-report':forms.reportForm,'view-report':forms.reportDetail,
  'new-evaluation':forms.evaluationForm,
  'new-survey':()=>forms.surveyForm(),'edit-survey':forms.surveyForm,'respond-survey':forms.respondSurvey,'survey-results':forms.surveyResults,
  'new-invoice':operationForms.invoiceForm,'view-invoice':operationForms.invoiceDetail,'record-payment':operationForms.paymentForm,
  'new-contract':()=>operationForms.contractForm(),'edit-contract':operationForms.contractForm,'view-contract':operationForms.contractDetail,'acknowledge-contract':operationForms.acknowledgeForm,
  'new-message':()=>operationForms.messageForm(),'message-person':operationForms.messageForm,
};
document.addEventListener('click',async event=>{
  const workspace=document.querySelector('.workspace');
  if(workspace?.classList.contains('menu-open')&&event.target.closest('.sidebar nav a'))setMenu(false, false);
  const target=event.target.closest('[data-action]');if(!target||target.disabled)return;
  const action=target.dataset.action,id=target.dataset.id;
  try{
    if(simple[action])return simple[action](id);
    if(action==='close-modal')return closeModal();
    if(action==='print')return window.print();
    if(action==='toggle-menu'){setMenu(!document.querySelector('.workspace').classList.contains('menu-open'));return;}
    if(action==='close-menu'){setMenu(false);return;}
    if(action==='open-cohort'){location.hash=`cohort/${id}`;return;}
    if(action==='message-coach')return operationForms.messageForm(app.data.users.find(u=>u.role==='coach')?.id);
    if(action==='book-one-to-one'){
      if(!app.data.cohorts.length)return modal('Join a cohort first',empty('No cohort is available to book against.'));
      modal('Your individual coaching session','<div id="one-to-one-booking"></div>');
      return await mountBooking(document.getElementById('one-to-one-booking'),{participant:true});
    }
    if(action==='copy-invite'){
      const value=location.origin+'/portal.html?invite='+target.dataset.token;
      try{await navigator.clipboard.writeText(value);toast('Invitation link copied.');}catch{const input=target.parentElement.querySelector('input');input.focus();input.select();toast('Select and copy the invitation link.');}return;
    }
    target.disabled=true;
    if(action.startsWith('demo-'))return await signIn('auth/demo',{role:action.slice(5)});
    if(action==='logout'){authEpoch++;await api('auth/logout',{});app.data=null;login();return;}
    if(action==='join-session'){const popup=window.open('','_blank');if(popup)popup.opener=null;try{const result=await api(`sessions/${id}/join`);if(popup)popup.location.replace(result.url);else modal('Join your session',`<a class="btn primary" target="_blank" rel="noopener noreferrer" href="${e(result.url)}">Open meeting ↗</a>`);}catch(error){popup?.close();throw error;}return;}
    if(action==='invite-buyer'){const result=await act('invite-buyer',{id});showInvitations(result.invitations);return;}
    if(action==='confirm-poll'){await act('confirm-poll',{id,index:Number(target.dataset.index)});closeModal();toast('Schedule confirmed. Participants have an in-app notification.');return;}
    if(action==='read-all'){await act('read-notification',{});toast('Notifications marked as read.');return;}
    if(action==='run-reminders'){const result=await act('run-reminders',{});toast(`${result.created} in-app reminders created. Email drafts remain unsent.`);return;}
    if(action==='calendly-webhook'||action==='calendly-disconnect'){
      await api(action==='calendly-webhook'?'calendly/webhook':'calendly/disconnect',{});
      await app.refresh();toast(action==='calendly-webhook'?'Calendly booking sync is active.':'Calendly disconnected.');return;
    }
    if(['zoom-sync','zoom-remove','zoom-disconnect'].includes(action)){
      await api(`zoom/${action.slice(5)}`,{sessionId:id});await app.refresh();
      if(action!=='zoom-disconnect')forms.sessionDetail(id);
      toast(action==='zoom-sync'?'Zoom meeting is ready.':action==='zoom-remove'?'Zoom meeting removed.':'Zoom disconnected. Existing meetings remain available.');return;
    }
    if(['read-notification','archive-document','cancel-session','issue-invoice','request-contract-review'].includes(action)){
      await act(action,{id});closeModal();toast(action==='issue-invoice'?'Invoice is available in the buyer’s account.':action==='request-contract-review'?'Buyer review requested in the workspace. DocuSign is not connected.':'Saved.');return;
    }
  }catch(error){toast(error.message,true);}finally{target.disabled=false;}
});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!form.dataset.form)return;
  event.preventDefault();if(form.dataset.busy||!form.reportValidity())return;
  form.dataset.busy='true';const submitButton=form.querySelector('[type="submit"]'),old=submitButton.innerHTML,errorBox=form.querySelector('.form-error');submitButton.disabled=true;submitButton.textContent='Saving…';if(errorBox)errorBox.hidden=true;
  try{
    const values=Object.fromEntries(new FormData(form));
    if(form.dataset.form==='login')await signIn('auth/login',values);
    else if(form.dataset.form==='accept')await signIn('auth/accept',values);
    else await submit(form);
  }catch(error){if(errorBox){errorBox.textContent=error.message;errorBox.hidden=false;}else toast(error.message,true);}
  finally{delete form.dataset.busy;submitButton.disabled=false;submitButton.innerHTML=old;}
});
document.addEventListener('change',async event=>{
  const input=event.target;
  try{
    if(input.id==='cohort-filter'){app.cohortId=input.value;render();}
    if(input.dataset.leadStage)await act('lead-stage',{id:input.dataset.leadStage,stage:input.value});
    if(input.dataset.enrollment)await act('enrollment-status',{id:input.dataset.enrollment,status:input.value});
    if(input.hasAttribute('data-dependent-cohort')){
      const form=input.form,participants=form.querySelector('[data-participant-select]'),sessions=form.querySelector('[data-session-select]');
      if(participants)participants.innerHTML=participantOptions(input.value).map(([id,name])=>`<option value="${e(id)}">${e(name)}</option>`).join('');
      if(sessions)sessions.innerHTML='<option value="">Shared resource library</option>'+app.data.sessions.filter(s=>s.cohortId===input.value).map(s=>`<option value="${e(s.id)}">${e(s.title)}</option>`).join('');
    }
  }catch(error){toast(error.message,true);await app.refresh();}
});
window.addEventListener('hashchange',()=>{render();document.getElementById('main')?.focus({preventScroll:true});window.scrollTo(0,0);});
document.addEventListener('keydown', event => {
  if (!document.querySelector('.workspace.menu-open')) return;
  if (event.key === 'Escape') { event.preventDefault(); setMenu(false); }
  if (event.key === 'Tab') {
    const elements = [...document.querySelectorAll('.sidebar a[href], .sidebar button:not([disabled])')].filter(el => el.getClientRects().length);
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
window.matchMedia('(max-width:850px)').addEventListener('change', () => setMenu(false, false));
document.getElementById('modal').addEventListener('click',event=>{if(event.target.id==='modal')closeModal();});
async function boot(){
  try{
    config=await api('public/config');
    prototypeSwitcher=mountPrototypeSwitcher({enabled:config.demoEnabled,onChange:switchPrototypeView});
    const token=new URL(location.href).searchParams.get('invite');
    if(token)return invitation(token);
    await app.refresh();
  }catch(error){login(error.message);}
}
setInterval(()=>{if(app.data&&!document.hidden&&!document.getElementById('modal').open&&!document.querySelector('.workspace.menu-open')&&!document.activeElement?.matches('input,select,textarea,button,a'))app.refresh().catch(()=>{});},30000);
boot();
