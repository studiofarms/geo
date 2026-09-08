import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {PostgresStore} from '../../src/server/postgres/store.mjs';
import {Calendly} from '../../src/server/calendly/service.mjs';
import {createNetlifyHandler} from '../../src/server/netlify/handler.mjs';
import {passwordHash} from '../../src/server/platform/core.mjs';
if(process.env.GOCOACH_DB_TEST!=='isolated-cluster')throw new Error('Use npm run db:test');
const pool=new pg.Pool({max:8});after(()=>pool.end());
const origin='https://gocoach.example.test',api='https://api.calendly.com',password='A long testing password',passwordDigest=passwordHash(password);
const discoveryUrl='https://calendly.com/test-coach/discovery',oneToOneUrl='https://calendly.com/test-coach/individual';
async function fixture(){
  const workspaceId=randomUUID(),store=new PostgresStore({pool,workspaceId,bootstrap:{email:'coach@example.test',name:'Test Coach',passwordHash:passwordDigest}});
  const ids={buyer:randomUUID(),participant:randomUUID(),buyerUser:randomUUID(),cohort:randomUUID()};
  await store.run(db=>{
    db.buyers.push({id:ids.buyer,company:'Test Buyer',contact:'Buyer',email:'buyer@example.test',billingEmail:'buyer@example.test'});
    db.users.push({id:ids.buyerUser,name:'Buyer',email:'buyer@example.test',role:'buyer',buyerId:ids.buyer,passwordHash:passwordDigest},{id:ids.participant,name:'Participant',email:'participant@example.test',role:'participant',passwordHash:passwordDigest});
    db.cohorts.push({id:ids.cohort,buyerId:ids.buyer,name:'Test Cohort',startDate:'2031-01-01',endDate:'2031-12-31',timeZone:'America/Chicago',capacity:10,price:10000,status:'active'});
    db.enrollments.push({id:randomUUID(),cohortId:ids.cohort,userId:ids.participant,status:'enrolled'});
  },true);
  const calls=[],events=new Map();let webhook,loseResponse=false;
  const token=`fake-test-token-${randomUUID()}`;
  const fetcher=async(url,options)=>{
    assert.equal(options.headers.Authorization,`Bearer ${token}`);calls.push({path:url.pathname,method:options.method||'GET'});
    if(url.pathname==='/users/me')return Response.json({resource:{uri:`${api}/users/coach`,current_organization:`${api}/organizations/test-org`,name:'Test Coach',email:'coach@example.test'}});
    if(url.pathname==='/event_types')return Response.json({collection:[{uri:`${api}/event_types/discovery`,name:'Discovery',duration:30,scheduling_url:discoveryUrl},{uri:`${api}/event_types/individual`,name:'Individual',duration:30,scheduling_url:oneToOneUrl}]});
    if(url.pathname==='/webhook_subscriptions'&&options.method==='POST'){
      const body=JSON.parse(options.body);webhook={...body,uri:`${api}/webhook_subscriptions/test-hook`,callback_url:body.url,state:'active'};
      if(loseResponse){loseResponse=false;throw new Error('Simulated connection lost after creation');}
      return Response.json({resource:webhook});
    }
    if(url.pathname==='/webhook_subscriptions')return Response.json({collection:webhook?[webhook]:[]});
    if(url.pathname==='/webhook_subscriptions/test-hook'&&options.method==='DELETE'){webhook=null;return new Response(null,{status:204});}
    if(events.has(url.href))return Response.json({resource:events.get(url.href)});
    throw new Error(`Unexpected mock path: ${url.pathname}`);
  };
  const calendly=new Calendly({store,secretKey:randomBytes(32).toString('hex'),origin,fetcher});
  const handler=createNetlifyHandler({store,demo:false,origins:[origin],calendly});
  const request=async(path,body,cookie='',extra={})=>{
    const r=await handler(new Request(origin+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',cookie,origin,...extra},body:body?JSON.stringify(body):undefined}),{ip:'127.0.0.1'});
    return {status:r.status,headers:r.headers,body:await r.json()};
  };
  const login=async email=>{const r=await request('/api/platform/auth/login',{email,password});assert.equal(r.status,200,JSON.stringify(r.body));return r.headers.get('set-cookie').split(';')[0];};
  const coach=await login('coach@example.test'),participant=await login('participant@example.test'),buyer=await login('buyer@example.test');
  const configure=()=>request('/api/platform/calendly/connect',{token,discoveryUrl,oneToOneUrl,enabled:true},coach);
  const sync=()=>request('/api/platform/calendly/webhook',{},coach);
  const send=async(event,signature)=>{
    const raw=JSON.stringify(event),timestamp=Math.floor(Date.now()/1000);
    const sig=signature||`t=${timestamp},v1=${createHmac('sha256',webhook.signing_key).update(`${timestamp}.${raw}`).digest('hex')}`;
    const r=await handler(new Request(origin+'/api/webhooks/calendly',{method:'POST',body:raw,headers:{'calendly-webhook-signature':sig}}));return {status:r.status,body:await r.json()};
  };
  const booking=(kind='discovery',eventId=randomUUID(),details={})=>{
    const eventUri=`${api}/scheduled_events/${eventId}`;
    events.set(eventUri,{event_type:`${api}/event_types/${kind}`,start_time:'2031-06-02T16:00:00Z',end_time:'2031-06-02T16:30:00Z',status:'active',location:{join_url:'https://meet.google.com/abc-defg-hij'}});
    return {event:'invitee.created',created_at:'2031-05-01T00:00:00Z',payload:{uri:`${eventUri}/invitees/invitee`,event:eventUri,name:'Participant',email:'participant@example.test',status:'active',updated_at:'2031-05-01T00:00:00Z',reschedule_url:'https://calendly.com/reschedulings/token',cancel_url:'https://calendly.com/cancellations/token',...details}};
  };
  return {store,ids,request,calendly,coach,buyer,participant,configure,sync,send,booking,events,calls,token,loseNext:()=>{loseResponse=true;}};
}
test('Netlify API persists production sign-in and restricts encrypted Calendly settings to coaches',async()=>{
  const f=await fixture();assert.equal((await f.request('/api/health')).body.storage,'postgres');
  assert.equal((await f.request('/api/platform/auth/demo',{role:'coach'})).status,403);
  assert.equal((await f.request('/api/platform/calendly/connect',{token:f.token,discoveryUrl,enabled:true},f.buyer)).status,403);
  assert.equal((await f.request('/api/platform/calendly/connect',{},f.coach,{origin:'https://attacker.test'})).status,403);
  const result=await f.configure();assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.tokenConfigured,true);
  for(const cookie of ['',f.coach,f.participant,f.buyer]){
    const r=await f.request(cookie?'/api/platform/state':'/api/platform/public/config',null,cookie);
    assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(!JSON.stringify(r.body).includes(f.token));
    if(cookie===f.buyer)assert.equal(r.body.calendly.accountEmail,undefined);
  }
  const {rows:[secret]}=await pool.query('SELECT encrypted_value FROM gocoach.integration_secrets WHERE workspace_id=$1',[f.store.workspaceId]);
  assert.ok(secret.encrypted_value.startsWith('v1.'));assert.ok(!secret.encrypted_value.includes(f.token));
  assert.equal((await f.request('/api/platform/public/book',{startsAt:'2031-06-02T16:00:00Z'})).status,409);
});
test('Calendly recovers a lost webhook registration response and syncs create/cancel/replay safely',async()=>{
  const f=await fixture();await f.configure();f.loseNext();assert.equal((await f.sync()).status,502);
  assert.equal((await f.sync()).status,200);assert.equal((await f.sync()).status,200);
  assert.equal(f.calls.filter(c=>c.path==='/webhook_subscriptions'&&c.method==='POST').length,1);
  const event=f.booking();assert.equal((await f.send(event,'t=0,v1='+'0'.repeat(64))).status,401);
  let r=await f.send(event);assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal((await f.send(event)).body.duplicate,true);
  let db=await f.store.run(db=>db);assert.equal(db.sessions.length,1);assert.equal(db.leads.length,1);assert.equal(db.sessions[0].provider,'calendly');
  const cancel={...event,event:'invitee.canceled',payload:{...event.payload,status:'canceled',updated_at:'2031-05-02T00:00:00Z'}};
  assert.equal((await f.send(cancel)).status,200);
  assert.equal((await f.send({...event,payload:{...event.payload,updated_at:'2031-05-01T01:00:00Z'}})).body.status,'ignored');
  db=await f.store.run(db=>db);assert.equal(db.sessions[0].status,'cancelled');
  assert.equal((await f.request('/api/platform/action',{action:'save-session',payload:{id:db.sessions[0].id,status:'scheduled'}},f.coach)).status,409);
  assert.equal((await f.request('/api/platform/calendly/disconnect',{},f.coach)).status,200);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM gocoach.integration_secrets WHERE workspace_id=$1',[f.store.workspaceId])).rows[0].n,0);
});
test('participant cohort context, private booking links and reschedules remain bound to enrollment',async()=>{
  const f=await fixture();await f.configure();await f.sync();
  assert.equal((await f.request('/api/platform/calendly/booking-link',{cohortId:randomUUID()},f.participant)).status,403);
  const link=await f.request('/api/platform/calendly/booking-link',{cohortId:f.ids.cohort},f.participant);assert.equal(link.status,200,JSON.stringify(link.body));
  const context=new URL(link.body.url).searchParams.get('utm_content');assert.equal(context.length,64);assert.ok(!context.includes(f.ids.participant));
  const event=f.booking('individual',randomUUID(),{tracking:{utm_content:context}});
  const r=await f.send(event);assert.equal(r.status,200,JSON.stringify(r.body));
  const mine=(await f.request('/api/platform/state',null,f.participant)).body.sessions[0];assert.ok(mine.cancelUrl);assert.equal(mine.cohortId,f.ids.cohort);
  const buyer=(await f.request('/api/platform/state',null,f.buyer)).body;assert.equal(buyer.sessions.length,0);
  assert.equal((await f.request('/api/platform/action',{action:'cancel-session',payload:{id:mine.id}},f.participant)).status,409);
  await pool.query("UPDATE gocoach.booking_contexts SET expires_at=now()-interval '1 day' WHERE workspace_id=$1",[f.store.workspaceId]);
  const reschedule=f.booking('individual',randomUUID(),{old_invitee:event.payload.uri,tracking:{utm_content:context},updated_at:'2031-05-02T00:00:00Z'});
  f.events.get(reschedule.payload.event).start_time='2031-06-02T17:00:00Z';f.events.get(reschedule.payload.event).end_time='2031-06-02T17:30:00Z';
  const moved=await f.send(reschedule);assert.equal(moved.status,200,JSON.stringify(moved.body));
  const sessions=await f.store.run(db=>db.sessions);assert.equal(sessions.length,2);assert.equal(sessions.find(s=>s.id===mine.id).status,'cancelled');assert.equal(sessions.find(s=>s.status==='scheduled').participantId,f.ids.participant);
  const conflict=f.booking('discovery');f.events.get(conflict.payload.event).start_time='2031-06-02T17:00:00Z';f.events.get(conflict.payload.event).end_time='2031-06-02T17:30:00Z';
  assert.equal((await f.send(conflict)).body.status,'received');assert.equal((await f.store.run(db=>db.sessions)).length,2);
  const unmatched=f.booking('individual',randomUUID(),{email:'someoneelse@example.test'});
  assert.equal((await f.send(unmatched)).body.status,'received');assert.equal((await f.store.run(db=>db.sessions)).length,2);
});
test('unconfigured production fails closed and deploy previews cannot register webhooks',async()=>{
  const empty=new PostgresStore({pool,workspaceId:randomUUID()});await assert.rejects(empty.run(()=>null),e=>e.status===503);
  const f=await fixture();await f.configure();f.calendly.allowExternalWrites=false;assert.equal((await f.sync()).status,409);
  const user=await f.store.run(db=>db.users.find(u=>u.role==='coach'));f.store.demo=true;
  await assert.rejects(f.calendly.save(user,{token:f.token}),e=>e.status===409);
});
