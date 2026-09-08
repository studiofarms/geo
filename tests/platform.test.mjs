import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/http.mjs';
import { plusWeeks, zonedInstant } from '../src/server/platform/scheduling.mjs';
import { Store } from '../src/server/platform/store.mjs';
import { passwordHash } from '../src/server/platform/core.mjs';
import { runReminders } from '../src/server/platform/operations.mjs';
import { snapshot } from '../src/server/platform/visibility.mjs';
import { seed } from '../src/server/platform/seed.mjs';
import { parseCSV, manualEmails } from '../src/platform/csv.js';
import { app } from '../src/platform/ui.js';
import * as views from '../src/platform/views.js';
import * as operationViews from '../src/platform/operations-views.js';
import { changePrototypeView, mountPrototypeSwitcher } from '../src/prototype.js';
const source=fileURLToPath(new URL('../src',import.meta.url));
const temporary=await mkdtemp(join(tmpdir(),'gocoach-platform-'));
const servers=[];
after(async()=>{await Promise.all(servers.map(server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})));await rm(temporary,{recursive:true,force:true});});
const dateAfter=days=>new Date(Date.now()+days*86400000).toISOString();
async function fixture(development=true){
  const directory=join(temporary,randomUUID()),inquiries=join(directory,'inquiries');
  const server=createApp({root:source,dataDirectory:inquiries,development});servers.push(server);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(path,body,cookie='',headers={}){
    const response=await fetch(base+'/api/platform/'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text(),headers:response.headers};
  }
  async function login(role){const response=await request('auth/demo',{role});assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];}
  const action=(name,payload,cookie,headers)=>request('action',{action:name,payload},cookie,headers);
  const storePath=join(directory,development?'platform-development':'platform-production','workspace.json');
  return {request,login,action,storePath,base,directory};
}

test('unauthenticated access is blocked and demo login uses a protected cookie',async()=>{
  const f=await fixture();assert.equal((await f.request('state')).status,401);
  const login=await f.request('auth/demo',{role:'coach'});assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request('state',null,cookie)).body.user.role,'coach');
  await f.request('auth/logout',{},cookie);assert.equal((await f.request('state',null,cookie)).status,401);
});

test('production disables sample accounts and supports password-based coach authentication',async()=>{
  const f=await fixture(false);assert.equal((await f.request('auth/demo',{role:'coach'})).status,403);
  const store=new Store(join(f.directory,'platform-production'),false);
  await store.run(db=>{db.users.push({id:'production-coach',role:'coach',name:'Coach',email:'coach@example.test',passwordHash:passwordHash('a-long-test-password')});},true);
  // A separate server reads the same durable store, as a real restart would.
  const server=createApp({root:source,dataDirectory:join(f.directory,'inquiries'),development:false});servers.push(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/platform/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'coach@example.test',password:'a-long-test-password'})});
  assert.equal(response.status,200);assert.ok(response.headers.get('set-cookie'));
  assert.ok(!(await readFile(f.storePath,'utf8')).includes('a-long-test-password'));
});

test('role snapshots enforce company ownership, coach-private notes, and document scopes',async()=>{
  const f=await fixture(),coach=await f.login('coach'),buyer=await f.login('buyer'),participant=await f.login('participant');
  const c=(await f.request('state',null,coach)).body,b=(await f.request('state',null,buyer)).body,p=(await f.request('state',null,participant)).body;
  assert.equal(c.cohorts.length,2);assert.equal(b.cohorts.length,1);assert.equal(p.cohorts.length,1);
  assert.equal(b.buyers.length,1);assert.equal(p.buyers.length,0);
  assert.ok(c.sessions.some(s=>s.privateNotes));assert.ok(p.sessions.every(s=>!('privateNotes'in s)));assert.ok(b.sessions.every(s=>!('privateNotes'in s)));
  assert.ok(c.documents.some(d=>d.scope==='private'));assert.ok(!p.documents.some(d=>['buyer','private'].includes(d.scope)));
  assert.ok(!('leads'in b));assert.ok(!('subscribers'in p));assert.ok(!('authSessions'in c));assert.ok(c.users.every(u=>!('passwordHash'in u)));
  assert.equal((await f.request('documents/document-private',null,participant)).status,403);
  assert.equal((await f.request('documents/document-buyer',null,participant)).status,403);
  assert.equal((await f.request('documents/document-buyer',null,buyer)).status,200);
  assert.equal((await f.action('lead-stage',{id:'lead-one',stage:'closed'},buyer)).status,403);
  assert.equal((await f.action('save-buyer',{id:'buyer-atlas'},buyer)).status,403);
});

test('prototype navigation switches the browser session and public view signs out',async()=>{
  const f=await fixture();let cookie='';
  const request=async(path,body)=>{
    const result=await f.request(path,body,cookie);
    if(result.status>=400)throw Object.assign(new Error(result.body.error),{status:result.status});
    const session=result.headers.get('set-cookie');if(session)cookie=session.split(';')[0];
    return result.body;
  };
  for(const view of ['coach','participant','buyer','coach']){
    assert.equal(await changePrototypeView(view,request),'/portal.html#dashboard');
    const state=await request('state');
    assert.equal(state.user.role,view);
    assert.equal('leads' in state,view==='coach');
    assert.equal(state.documents.some(document=>document.scope==='private'),view==='coach');
    if(view==='participant')assert.equal(state.buyers.length,0);
  }
  assert.equal(await changePrototypeView('public',request),'/');
  assert.equal((await f.request('state',null,cookie)).status,401);
  assert.equal(await changePrototypeView('public',request),'/');
});

test('prototype navigation stays disabled in production and rejects unsupported views',async()=>{
  const f=await fixture(false);
  assert.equal((await f.request('public/config')).body.demoEnabled,false);
  assert.equal(mountPrototypeSwitcher({enabled:false,onChange:async()=>{}}),null);
  const request=async(path,body)=>{
    const result=await f.request(path,body);
    if(result.status>=400)throw Object.assign(new Error(result.body.error),{status:result.status});
    return result.body;
  };
  for(const view of ['coach','buyer','participant'])await assert.rejects(changePrototypeView(view,request),{status:403});
  await assert.rejects(changePrototypeView('admin',()=>assert.fail('Unexpected authentication request')),/Choose an available/);
  assert.equal((await f.request('state')).status,401);
});

test('discovery booking checks conflicts, creates a lead, supports retry, calendar, and cancellation',async()=>{
  const f=await fixture();const slots=(await f.request('public/slots?from='+new Date().toISOString().slice(0,10))).body;
  assert.ok(slots.slots.length);assert.equal(slots.duration,30);assert.equal(slots.price,0);
  const body={name:'New Lead',email:'lead@example.test',company:'Test Company',startsAt:slots.slots[0],consent:true,requestId:randomUUID()};
  const one=await f.request('public/book',body);assert.equal(one.status,201);
  const retry=await f.request('public/book',body);assert.equal(retry.body.id,one.body.id);assert.equal(retry.body.token,one.body.token);
  assert.equal((await f.request('public/book',{...body,requestId:randomUUID(),email:'other@example.test'})).status,409);
  const calendar=await f.request('public/booking-calendar?token='+one.body.token);assert.equal(calendar.status,200);assert.match(calendar.body,/BEGIN:VCALENDAR/);
  const coach=await f.login('coach'),state=(await f.request('state',null,coach)).body;
  assert.ok(state.leads.some(l=>l.email==='lead@example.test'));assert.ok(state.hooks.some(h=>h.kind==='calendar.event.created'));
  assert.equal((await f.request('public/cancel-booking',{token:one.body.token})).status,200);
  assert.equal((await f.request('public/book',{...body,requestId:randomUUID()})).status,201);
});

test('concurrent booking attempts cannot reserve the same slot twice',async()=>{
  const f=await fixture(),slot=(await f.request('public/slots')).body.slots[0];
  const responses=await Promise.all([1,2].map(i=>f.request('public/book',{name:'Person '+i,email:`p${i}@example.test`,startsAt:slot,consent:true})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
});

test('newsletter opt-in is required, deduplicated, private, and reversible',async()=>{
  const f=await fixture();assert.equal((await f.request('public/subscribe',{email:'list@example.test',consent:false})).status,422);
  const response=await f.request('public/subscribe',{email:'list@example.test',consent:true});assert.equal(response.status,200);assert.ok(response.body.unsubscribeToken);
  await f.request('public/subscribe',{email:'list@example.test',consent:true});
  const coach=await f.login('coach');assert.equal((await f.request('state',null,coach)).body.subscribers.length,1);
  await f.request('public/unsubscribe',{token:response.body.unsubscribeToken});assert.equal((await f.request('state',null,coach)).body.subscribers[0].status,'unsubscribed');
});

test('cohort creation, bulk invitation, account acceptance, and enrollment persist',async()=>{
  const f=await fixture(),coach=await f.login('coach');
  const response=await f.action('save-cohort',{name:'Test cohort',buyerId:'buyer-northstar',startDate:dateAfter(30),endDate:dateAfter(107),capacity:2,timeZone:'America/Chicago',price:1200,status:'enrolling',emails:['new@example.test','new@example.test']},coach);
  assert.equal(response.status,200);assert.equal(response.body.invitations.length,1);
  const token=response.body.invitations[0].token;
  const accept=await f.request('auth/accept',{token,name:'New Participant',password:'a-secure-test-password'});assert.equal(accept.status,200);
  assert.equal((await f.request('auth/accept',{token,name:'New Participant',password:'a-secure-test-password'})).status,410);
  const cookie=accept.headers.get('set-cookie').split(';')[0],state=(await f.request('state',null,cookie)).body;
  assert.equal(state.cohorts.length,1);assert.equal(state.cohorts[0].name,'Test cohort');assert.equal(state.enrollments[0].status,'enrolled');assert.equal(state.sessions.length,6);
  assert.equal((await f.action('bulk-invite',{cohortId:response.body.id,emails:['second@example.test','third@example.test']},coach)).status,409);
  const disk=await readFile(f.storePath,'utf8');assert.ok(!disk.includes('a-secure-test-password'));assert.ok(!disk.includes('third@example.test'));
  const login=await f.request('auth/login',{email:'new@example.test',password:'a-secure-test-password'});assert.equal(login.status,200);
});

test('polls require five distinct preferences and coach confirmation updates the session series',async()=>{
  const f=await fixture(),coach=await f.login('coach'),participant=await f.login('participant');
  assert.equal((await f.action('respond-poll',{id:'poll-demo',choices:[0,0,1,2,3]},participant)).status,422);
  assert.equal((await f.action('respond-poll',{id:'poll-demo',choices:[0,1,2,3,4]},participant)).status,200);
  assert.equal((await f.action('confirm-poll',{id:'poll-demo',index:0},participant)).status,403);
  assert.equal((await f.action('confirm-poll',{id:'poll-demo',index:0},coach)).status,200);
  const state=(await f.request('state',null,participant)).body;
  assert.equal(state.polls[0].status,'confirmed');assert.ok(state.notifications.some(n=>n.title.includes('schedule is confirmed')));
  assert.equal((await f.action('respond-poll',{id:'poll-demo',choices:[1,2,3,4,5]},participant)).status,409);
});

test('scheduling preserves Chicago wall-clock time across daylight-saving transitions',()=>{
  const start=zonedInstant('2026-10-25',10,0,'America/Chicago');
  assert.equal(start,'2026-10-25T15:00:00.000Z');
  assert.equal(plusWeeks(start,2,'America/Chicago'),'2026-11-08T16:00:00.000Z');
});

test('participant 1:1s are private and cannot be booked against another buyer’s cohort',async()=>{
  const f=await fixture(),participant=await f.login('participant'),buyer=await f.login('buyer');
  const slot=(await f.request('public/slots')).body.slots[0];
  assert.equal((await f.action('book-one-to-one',{cohortId:'cohort-next',startsAt:slot},participant)).status,403);
  const booked=await f.action('book-one-to-one',{cohortId:'cohort-forward',startsAt:slot},participant);assert.equal(booked.status,200);
  const buyerState=(await f.request('state',null,buyer)).body;
  assert.ok(!buyerState.sessions.some(s=>s.id===booked.body.id));
  assert.equal((await f.request(`sessions/${booked.body.id}/calendar`,null,buyer)).status,403);
});

test('session join links are time-gated and never open for buyers',async()=>{
  const f=await fixture(),coach=await f.login('coach'),participant=await f.login('participant'),buyer=await f.login('buyer');
  const state=(await f.request('state',null,coach)).body,session=state.sessions.find(s=>s.id==='session-2');
  const update=await f.action('save-session',{...session,startsAt:new Date(Date.now()+5*60000).toISOString(),meetingUrl:'https://meet.google.com/abc-defg-hij'},coach);assert.equal(update.status,200);
  assert.equal((await f.request('sessions/session-2/join',null,participant)).status,200);
  assert.equal((await f.request('sessions/session-2/join',null,buyer)).status,403);
  assert.equal((await f.request('sessions/session-3/join',null,participant)).status,403);
});

test('document uploads enforce individual visibility and protected downloads',async()=>{
  const f=await fixture(),coach=await f.login('coach'),participant=await f.login('participant'),buyer=await f.login('buyer');
  const uploaded=await f.action('upload-document',{cohortId:'cohort-forward',title:'Private reflection',filename:'reflection.txt',scope:'individual',participantId:'participant-demo',base64:Buffer.from('Private test content').toString('base64')},coach);assert.equal(uploaded.status,200);
  assert.equal((await f.request('documents/'+uploaded.body.id,null,participant)).body,'Private test content');
  assert.equal((await f.request('documents/'+uploaded.body.id,null,buyer)).status,403);
  assert.equal((await f.action('upload-document',{cohortId:'cohort-forward'},participant)).status,403);
  const invalid=await f.action('upload-document',{cohortId:'cohort-forward',title:'Nope',filename:'script.html',scope:'cohort',base64:Buffer.from('<script>bad</script>').toString('base64')},coach);assert.equal(invalid.status,422);
  await f.action('archive-document',{id:uploaded.body.id},coach);assert.equal((await f.request('documents/'+uploaded.body.id,null,participant)).status,403);
});

test('report drafts and individual buyer visibility are enforced',async()=>{
  const f=await fixture(),coach=await f.login('coach'),participant=await f.login('participant'),buyer=await f.login('buyer');
  const data={cohortId:'cohort-forward',type:'individual',participantId:'participant-demo',title:'Confidential reflection',highlights:'Private progress',shareBuyer:false,status:'draft'};
  const draft=await f.action('save-report',data,coach);assert.equal(draft.status,200);
  assert.ok(!(await f.request('state',null,participant)).body.reports.some(r=>r.id===draft.body.id));
  await f.action('save-report',{...data,id:draft.body.id,status:'published'},coach);
  assert.ok((await f.request('state',null,participant)).body.reports.some(r=>r.id===draft.body.id));
  assert.ok(!(await f.request('state',null,buyer)).body.reports.some(r=>r.id===draft.body.id));
  await f.action('save-report',{...data,id:draft.body.id,status:'published',shareBuyer:true},coach);
  assert.ok((await f.request('state',null,buyer)).body.reports.some(r=>r.id===draft.body.id));
  app.data=(await f.request('state',null,buyer)).body;app.cohortId='';
  assert.equal(views.participantEvaluations().find(row=>row.enrollment.userId==='participant-demo').report.id,draft.body.id);
  assert.equal((await f.action('save-report',{...data,id:draft.body.id},participant)).status,403);
  assert.equal((await f.action('save-report',{...data,id:draft.body.id},buyer)).status,403);
  const reflection=await f.action('save-report',{...data,title:'My own reflection',status:'published',shareBuyer:true,authorId:'coach-demo'},participant);
  assert.equal(reflection.status,200);
  app.data=(await f.request('state',null,buyer)).body;
  assert.equal(app.data.reports.find(report=>report.id===reflection.body.id).authorId,'participant-demo');
  assert.equal(views.participantEvaluations().find(row=>row.enrollment.userId==='participant-demo').report.id,draft.body.id);
  const stored=JSON.parse(await readFile(f.storePath,'utf8'));
  assert.ok(!snapshot(stored,stored.users.find(user=>user.id==='buyer-other-user')).reports.some(report=>report.id===draft.body.id));
});

test('buyer evaluation roster includes pending participants and filters by cohort without exposing drafts',()=>{
  const db=seed(true),buyer=db.users.find(user=>user.id==='buyer-demo');
  db.reports.push({...db.reports.find(report=>report.id==='evaluation-alex-demo'),id:'private-draft',status:'draft',highlights:'Private coach draft',updatedAt:dateAfter(1)});
  db.users.find(user=>user.id==='participant-demo').name='<img src=x onerror=alert(1)>';
  app.data=snapshot(db,buyer);app.cohortId='';
  const rows=views.participantEvaluations();
  assert.equal(rows.length,3);
  assert.equal(rows.filter(row=>row.report).length,2);
  assert.equal(rows.find(row=>row.enrollment.userId==='participant-sam').report,undefined);
  const html=views.evaluations();
  assert.ok(html.includes('Not yet shared'));
  assert.ok(html.includes('Read evaluation'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('Private coach draft'));
  assert.ok(!html.includes('data-action="new-evaluation"'));
  assert.ok(views.overview().includes('Coach evaluations'));
  assert.ok(views.cohortDetail('cohort-forward').includes('Coach evaluations'));
  app.cohortId='cohort-next';assert.equal(views.participantEvaluations().length,0);
  app.cohortId='';app.data=snapshot(db,db.users.find(user=>user.id==='coach-demo'));
  assert.equal(views.participantEvaluations().find(row=>row.enrollment.userId==='participant-demo').report.id,'private-draft');
  assert.ok(views.evaluations().includes('Continue draft'));
  assert.ok(views.evaluations().includes('data-action="new-evaluation"'));
});

test('pre/mid/post surveys expose aggregates to buyers while keeping written responses private',async()=>{
  const f=await fixture(),coach=await f.login('coach'),participant=await f.login('participant'),buyer=await f.login('buyer');
  assert.equal((await f.action('respond-survey',{id:'survey-pre',answers:[6,2,3,4,5]},participant)).status,422);
  assert.equal((await f.action('respond-survey',{id:'survey-pre',answers:[1,2,3,4,5],reflection:'Private written reflection'},participant)).status,200);
  const buyerSurvey=(await f.request('state',null,buyer)).body.surveys.find(s=>s.id==='survey-pre');
  assert.deepEqual(buyerSurvey.averages,[1,2,3,4,5]);assert.equal(buyerSurvey.responses.length,0);
  const coachSurvey=(await f.request('state',null,coach)).body.surveys.find(s=>s.id==='survey-pre');assert.equal(coachSurvey.responses[0].reflection,'Private written reflection');
  assert.equal((await f.action('save-survey',{...coachSurvey,questions:['A changed question']},coach)).status,409);
});

test('invoices, payment history, duplicate references, and revenue totals reconcile',async()=>{
  const f=await fixture(),coach=await f.login('coach'),buyer=await f.login('buyer');
  const invoice=await f.action('create-invoice',{cohortId:'cohort-forward',title:'Test invoice',amount:100,dueDate:dateAfter(10)},coach);assert.equal(invoice.status,200);
  assert.ok(!(await f.request('state',null,buyer)).body.invoices.some(i=>i.id===invoice.body.id));
  assert.equal((await f.action('issue-invoice',{id:invoice.body.id},coach)).status,200);
  const payment={id:invoice.body.id,amount:40,date:new Date().toISOString(),method:'Bank transfer',reference:'TEST-PAYMENT-001'};
  assert.equal((await f.action('record-payment',payment,coach)).status,200);
  assert.equal((await f.action('record-payment',payment,coach)).status,409);
  assert.equal((await f.action('record-payment',{...payment,amount:61,reference:'OVER'},coach)).status,422);
  const recorded=(await f.request('state',null,buyer)).body.invoices.find(i=>i.id===invoice.body.id);assert.equal(recorded.paid,4000);assert.equal(recorded.balance,6000);assert.equal(recorded.displayStatus,'partial');
  assert.equal((await f.action('record-payment',{...payment,amount:60,reference:'FINAL'},coach)).status,200);
  assert.equal((await f.request('state',null,buyer)).body.invoices.find(i=>i.id===invoice.body.id).displayStatus,'paid');
});

test('agreement review freezes content and records only an authorized local acknowledgement',async()=>{
  const f=await fixture(),coach=await f.login('coach'),buyer=await f.login('buyer'),participant=await f.login('participant');
  const contract=await f.action('save-contract',{cohortId:'cohort-forward',title:'Test agreement',amount:7200,terms:'Test program scope.'},coach);assert.equal(contract.status,200);
  await f.action('request-contract-review',{id:contract.body.id},coach);
  assert.equal((await f.action('save-contract',{id:contract.body.id,cohortId:'cohort-forward',title:'Changed',amount:7200,terms:'Changed'},coach)).status,409);
  assert.equal((await f.action('acknowledge-contract',{id:contract.body.id,name:'Alex',consent:true},participant)).status,403);
  assert.equal((await f.action('acknowledge-contract',{id:contract.body.id,name:'Morgan Lee',consent:true},buyer)).status,200);
  const state=(await f.request('state',null,buyer)).body;assert.equal(state.contracts[0].acknowledgement.method,'local-prototype');assert.match(state.contracts[0].contentHash,/^[a-f\d]{64}$/);
});

test('messages are delivered only to the intended workspace participants',async()=>{
  const f=await fixture(),coach=await f.login('coach'),participant=await f.login('participant'),buyer=await f.login('buyer');
  const sent=await f.action('send-message',{recipientId:'coach-demo',message:'Private message to coach'},participant);assert.equal(sent.status,200);
  assert.ok((await f.request('state',null,coach)).body.messages.some(m=>m.id===sent.body.id));
  assert.ok(!(await f.request('state',null,buyer)).body.messages.some(m=>m.id===sent.body.id));
  assert.equal((await f.action('send-message',{recipientId:'buyer-other-user',message:'Wrong company'},participant)).status,403);
});

test('reminders generate in-app notifications and unsent drafts exactly once per recipient',()=>{
  const db=seed(true),now=Date.now();db.sessions[1].startsAt=new Date(now+3600000).toISOString();
  const first=runReminders(db,now),second=runReminders(db,now);
  assert.ok(first.created>=2);assert.equal(second.created,0);assert.ok(db.outbox.every(item=>item.status==='draft-local'));
});

test('mutations are idempotent across retries and audited without saving the payload',async()=>{
  const f=await fixture(),coach=await f.login('coach'),headers={'Idempotency-Key':randomUUID()};
  const body={name:'One lead',email:'once@example.test',company:'Test',stage:'discovery',value:1200,note:'A private note'};
  const one=await f.action('save-lead',body,coach,headers),two=await f.action('save-lead',body,coach,headers);assert.equal(one.body.id,two.body.id);
  const state=(await f.request('state',null,coach)).body;assert.equal(state.leads.filter(l=>l.email===body.email).length,1);assert.ok(!JSON.stringify(state.audit).includes(body.note));
});

test('CSV imports handle headers, quoting, duplicates, and invalid rows',()=>{
  assert.deepEqual(parseCSV('\uFEFFName,Email\r\n"Lee, Morgan",morgan@example.test\r\nAlex,alex@example.test\r\nAlex,alex@example.test'),['morgan@example.test','alex@example.test']);
  assert.deepEqual(manualEmails('a@example.test; b@example.test\na@example.test'),['a@example.test','b@example.test']);
  assert.throws(()=>parseCSV('name,email\nBad,invalid'));
  assert.throws(()=>parseCSV('name,email\n"Unclosed,a@example.test'));
});

test('every role dashboard and authorized view renders with escaped user content',()=>{
  const db=seed(true);db.cohorts[0].name='<script>alert(1)</script>';
  for(const role of ['coach','buyer','participant']){
    const user=db.users.find(u=>u.role===role);app.data={...snapshot(db,user),integrations:[]};app.cohortId='';
    for(const view of ['overview','cohorts','sessions','availability','resources','reports','surveys']){
      const html=views[view]();assert.ok(html.length>100,`${role}: ${view}`);assert.ok(!html.includes('<script>alert(1)</script>'));assert.ok(!html.includes('NaN'));
    }
    assert.ok(views.cohortDetail('cohort-forward').includes('&lt;script&gt;'));
    for(const view of ['messages','notifications'])assert.ok(operationViews[view]().length>100);
    if(role!=='participant'){
      for(const view of ['billing','contracts'])assert.ok(operationViews[view]().length>100);
      const evaluations=views.evaluations();assert.ok(evaluations.length>100);assert.ok(!evaluations.includes('<script>alert(1)</script>'));
    }
    if(role==='coach'){assert.ok(views.pipeline().length>100);assert.ok(views.buyers().length>100);assert.ok(operationViews.reminders().length>100);assert.ok(operationViews.integrations().length>100);}
  }
});

test('platform refuses cross-origin mutations and never publishes its store or upload directory',async()=>{
  const f=await fixture();assert.equal((await f.request('auth/demo',{role:'coach'},'',{Origin:'https://unrelated.example'})).status,403);
  for(const path of ['/server/platform/store.mjs','/data/platform-development/workspace.json','/platform-development/workspace.json'])assert.equal((await fetch(f.base+path)).status,404);
});

test('multi-step reminder sequences run each due step once without a burst after downtime',()=>{
  const db=seed(true),now=Date.now();db.settings.reminderOffsets=[72,24,2];db.settings.reminderHours=72;
  db.sessions=[{...db.sessions[1],startsAt:new Date(now+70*3600000).toISOString()}];db.polls=[];db.surveys=[];
  assert.equal(runReminders(db,now).created,2);
  assert.equal(runReminders(db,now+47*3600000).created,2);
  assert.equal(runReminders(db,now+47*3600000).created,0);
  assert.equal(runReminders(db,now+69*3600000).created,2);
  const restarted=seed(true);restarted.settings.reminderOffsets=[72,24,2];restarted.sessions=db.sessions;restarted.polls=[];restarted.surveys=[];
  assert.equal(runReminders(restarted,now+69*3600000).created,2);
});

test('existing public inquiry submissions are imported into the coach pipeline exactly once',async()=>{
  const f=await fixture(),coach=await f.login('coach');
  const response=await fetch(f.base+'/api/inquiries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Inquiry Lead',email:'inquiry@example.test',organization:'Example Company',interest:'sponsor',message:'Not ready for a call.',consent:true})});
  assert.equal(response.status,201);
  const first=(await f.request('state',null,coach)).body;
  assert.equal(first.leads.filter(lead=>lead.email==='inquiry@example.test').length,1);
  assert.equal((await f.request('state',null,coach)).body.leads.filter(lead=>lead.email==='inquiry@example.test').length,1);
});
