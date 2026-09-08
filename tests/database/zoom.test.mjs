import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes,randomUUID} from 'node:crypto';
import {PostgresStore} from '../../src/server/postgres/store.mjs';
import {Zoom} from '../../src/server/zoom/service.mjs';
import {createNetlifyHandler} from '../../src/server/netlify/handler.mjs';
import {passwordHash} from '../../src/server/platform/core.mjs';
if(process.env.GOCOACH_DB_TEST!=='isolated-cluster')throw new Error('Use npm run db:test');
const pool=new pg.Pool({max:5});after(()=>pool.end());
const password='A synthetic test password',digest=passwordHash(password),origin='https://example.test';
async function fixture(){
  const store=new PostgresStore({pool,workspaceId:randomUUID(),bootstrap:{email:'coach@example.test',name:'Coach',passwordHash:digest}});
  const buyerId=randomUUID(),cohortId=randomUUID(),participantId=randomUUID(),sessionId=randomUUID();
  await store.run(db=>{
    db.buyers.push({id:buyerId,company:'Test',contact:'Buyer',email:'buyer@example.test',billingEmail:'buyer@example.test'});
    db.users.push({id:participantId,name:'Participant',email:'participant@example.test',role:'participant',passwordHash:digest});
    db.cohorts.push({id:cohortId,buyerId,name:'Cohort',timeZone:'UTC',startDate:'2031-01-01',endDate:'2031-12-31',capacity:5,price:0,status:'active'});
    db.enrollments.push({id:randomUUID(),cohortId,userId:participantId,status:'enrolled'});
    db.sessions.push({id:sessionId,cohortId,kind:'cohort',title:'Leadership practice',startsAt:'2031-06-01T16:00:00.000Z',duration:90,status:'scheduled',timeZone:'UTC',meetingUrl:'',privateNotes:'Private coach assessment'});
  },true);
  const secret='fake-zoom-secret-'+randomUUID(),token='fake-access-'+randomUUID(),meetings=new Map(),calls=[];let lost=false,failed=false;
  const fetcher=async(url,options)=>{
    const u=new URL(url);calls.push({path:u.pathname,method:options.method});
    if(u.origin==='https://zoom.us'){
      assert.equal(options.headers.Authorization,`Basic ${Buffer.from(`test-client:${secret}`).toString('base64')}`);
      assert.equal(new URLSearchParams(options.body).get('account_id'),'test-account');return Response.json({access_token:token,expires_in:3600});
    }
    assert.equal(options.headers.Authorization,`Bearer ${token}`);
    if(u.pathname==='/v2/users/coach%40example.test')return Response.json({id:'host-id',email:'coach@example.test',first_name:'Test',last_name:'Coach',status:'active'});
    if(u.pathname==='/v2/users/host-id/meetings'){
      if(options.method==='GET')return Response.json({meetings:[...meetings.values()]});
      const body=JSON.parse(options.body);assert.equal(body.settings.auto_recording,'none');assert.equal(body.settings.join_before_host,false);assert.ok(!JSON.stringify(body).includes('Private coach assessment'));
      if(failed){failed=false;throw new Error('Uncertain before provider acceptance');}
      const meeting={...body,id:12345678901,join_url:'https://us02web.zoom.us/j/12345678901?pwd=meeting-passcode',start_url:'https://us02web.zoom.us/s/12345678901?zak=HOST-ONLY-SECRET'};meetings.set(String(meeting.id),meeting);
      if(lost){lost=false;throw new Error('Response lost after provider creation');}return Response.json(meeting);
    }
    const id=u.pathname.split('/').at(-1),meeting=meetings.get(id);if(!meeting)return new Response(null,{status:404});
    if(options.method==='DELETE'){meetings.delete(id);return new Response(null,{status:204});}
    if(options.method==='PATCH'){Object.assign(meeting,JSON.parse(options.body));return new Response(null,{status:204});}
    return Response.json(meeting);
  };
  const zoom=new Zoom({store,secretKey:randomBytes(32).toString('hex'),fetcher});
  const handler=createNetlifyHandler({store,demo:false,origins:[origin],zoom});
  const request=async(path,body,cookie='')=>{const r=await handler(new Request(origin+'/api/platform/'+path,{method:body?'POST':'GET',headers:{origin,cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined}));return {status:r.status,headers:r.headers,body:await r.json()};};
  const login=async email=>{const r=await request('auth/login',{email,password});assert.equal(r.status,200,JSON.stringify(r.body));return r.headers.get('set-cookie').split(';')[0];};
  const coach=await login('coach@example.test'),participant=await login('participant@example.test');
  const connect=()=>request('zoom/connect',{accountId:'test-account',clientId:'test-client',clientSecret:secret,hostEmail:'coach@example.test',waitingRoom:true},coach);
  return {store,zoom,request,coach,participant,connect,secret,token,sessionId,meetings,calls,lose:()=>{lost=true;},fail:()=>{failed=true;},sync:()=>request('zoom/sync',{sessionId},coach)};
}
test('Zoom frontend connection encrypts credentials and never returns host tokens',async()=>{
  const f=await fixture();let r=await f.connect();assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.connected,true);
  assert.equal((await f.request('zoom/settings',null,f.participant)).status,403);
  assert.equal((await f.request('zoom/sync',{sessionId:f.sessionId},f.participant)).status,403);
  r=await f.sync();assert.equal(r.status,200,JSON.stringify(r.body));
  for(const cookie of [f.coach,f.participant]){const state=await f.request('state',null,cookie),json=JSON.stringify(state.body);assert.ok(!json.includes(f.secret));assert.ok(!json.includes(f.token));assert.ok(!json.includes('HOST-ONLY-SECRET'));if(cookie===f.participant)assert.equal(state.body.sessions[0].meetingUrl,'');}
  const {rows:[row]}=await pool.query("SELECT encrypted_value FROM gocoach.integration_secrets WHERE workspace_id=$1 AND name='zoom-credentials'",[f.store.workspaceId]);assert.ok(row.encrypted_value.startsWith('v1.'));assert.ok(!row.encrypted_value.includes(f.secret));
  assert.equal((await f.request('zoom/disconnect',{},f.coach)).status,200);assert.equal(f.meetings.size,1);assert.equal((await f.sync()).status,409);
});
test('Zoom creates once, recovers a lost response, updates timing, and removes the meeting',async()=>{
  const f=await fixture();await f.connect();f.lose();assert.equal((await f.sync()).status,502);
  let result=await f.sync();assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(f.meetings.size,1);
  assert.equal(f.calls.filter(c=>c.path==='/v2/users/host-id/meetings'&&c.method==='POST').length,1);
  await f.store.run(db=>{db.sessions[0].startsAt='2031-06-01T17:00:00.000Z';db.sessions[0].duration=60;},true);
  assert.equal((await f.sync()).status,200);assert.equal(f.meetings.get('12345678901').duration,60);assert.equal(f.meetings.get('12345678901').start_time,'2031-06-01T17:00:00Z');
  result=await f.request('zoom/remove',{sessionId:f.sessionId},f.coach);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(f.meetings.size,0);assert.equal(await f.store.run(db=>db.sessions[0].meetingUrl),'');
});
test('Zoom refuses ambiguous duplicate creation and leaves Calendly meetings with Calendly',async()=>{
  const f=await fixture();await f.connect();f.fail();assert.equal((await f.sync()).status,502);assert.equal((await f.sync()).status,409);
  assert.equal(f.calls.filter(c=>c.path==='/v2/users/host-id/meetings'&&c.method==='POST').length,1);
  await f.store.run(db=>{db.sessions[0].provider='calendly';},true);assert.equal((await f.sync()).status,409);
  f.zoom.allowExternalWrites=false;assert.equal((await f.connect()).status,409);
});
