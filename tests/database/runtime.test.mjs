import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {PostgresStore} from '../../src/server/postgres/store.mjs';
import {createPlatform} from '../../src/server/platform/router.mjs';
import {Readable} from 'node:stream';
if(process.env.GOCOACH_DB_TEST!=='isolated-cluster')throw new Error('Use npm run db:test');
const pool=new pg.Pool({max:5});after(()=>pool.end());
async function fixture(){
  const workspaceId=randomUUID(),store=new PostgresStore({pool,workspaceId,demo:true});
  const platform=createPlatform({store,development:true,timers:false});
  async function request(path,body,cookie=''){
    const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);Object.assign(req,{method:body?'POST':'GET',headers:{'content-type':'application/json',cookie},socket:{remoteAddress:'test'}});
    const response={status:200,headers:{},setHeader(k,v){this.headers[k.toLowerCase()]=v;},writeHead(status,headers){this.status=status;for(const[k,v]of Object.entries(headers||{}))this.setHeader(k,v);},end(value){this.value=value;}};
    try{await platform.handle(req,response,new URL(`https://example.test/api/platform/${path}`),['https://example.test']);}
    catch(error){if(!error.status)throw error;response.status=error.status;response.value=JSON.stringify({error:error.message});}
    return {status:response.status,headers:response.headers,body:response.headers['content-type']?.includes('application/json')||response.status>=400?JSON.parse(response.value):response.value};
  }
  const login=async role=>{const r=await request('auth/demo',{role});assert.equal(r.status,200,JSON.stringify(r.body));return r.headers['set-cookie'].split(';')[0];};
  const coach=await login('coach'),buyer=await login('buyer'),participant=await login('participant');
  return {store,workspaceId,request,coach,buyer,participant,action:(action,payload,cookie=coach)=>request('action',{action,payload},cookie)};
}
test('PostgreSQL seeds normalized records and preserves role isolation across instances',async()=>{
  const f=await fixture(),c=(await f.request('state',null,f.coach)).body,b=(await f.request('state',null,f.buyer)).body;
  assert.equal(c.cohorts.length,2);assert.equal(b.cohorts.length,1);assert.ok(!JSON.stringify(b).includes('Sample coach-only'));
  const other=new PostgresStore({pool,workspaceId:f.workspaceId,demo:true});
  assert.equal((await other.run(db=>db.users)).length,6);
  const rows=await pool.query('SELECT count(*)::int AS n FROM gocoach.reports WHERE workspace_id=$1',[f.workspaceId]);assert.equal(rows.rows[0].n,3);
  const doc=c.documents.find(d=>d.scope==='private');assert.equal((await f.request(`documents/${doc.id}`,null,f.participant)).status,403);
  assert.ok((await f.request(`documents/${doc.id}`,null,f.coach)).body.length>0);
});
test('database-backed cohort, invite, report, invoice, agreement, and document workflows',async()=>{
  const f=await fixture(),db=await f.store.run(db=>db),buyerId=db.buyers[0].id;
  const created=await f.action('save-cohort',{buyerId,name:'Database cohort',startDate:'2031-01-01',endDate:'2031-04-01',timeZone:'America/Chicago',capacity:4,price:1200,status:'enrolling',emails:['new@example.test']});
  assert.equal(created.status,200,JSON.stringify(created.body));
  const cohortId=created.body.id,invitation=created.body.invitations[0];
  const accept=await f.request('auth/accept',{token:invitation.token,name:'New participant',password:'a-secure-test-password'});assert.equal(accept.status,200,JSON.stringify(accept.body));
  const participantId=accept.body.user.id,participant=accept.headers['set-cookie'].split(';')[0];
  const report=await f.action('save-report',{cohortId,participantId,type:'individual',title:'Coach evaluation',highlights:'Observable strengths',progress:'Progress',nextSteps:'Practice',shareBuyer:true,status:'published'});assert.equal(report.status,200,JSON.stringify(report.body));
  const upload=await f.action('upload-document',{cohortId,participantId,title:'Private resource',filename:'resource.txt',base64:Buffer.from('Private database bytes').toString('base64'),scope:'individual'});assert.equal(upload.status,200,JSON.stringify(upload.body));
  assert.equal((await f.request(`documents/${upload.body.id}`,null,participant)).body.toString(),'Private database bytes');
  const invoice=await f.action('create-invoice',{cohortId,title:'Program fee',amount:100,dueDate:'2031-01-01'});assert.equal(invoice.status,200,JSON.stringify(invoice.body));
  assert.equal((await f.action('issue-invoice',{id:invoice.body.id})).status,200);
  const payment=await f.action('record-payment',{id:invoice.body.id,amount:60,method:'Manual',reference:'BANK-1',date:new Date().toISOString()});assert.equal(payment.status,200,JSON.stringify(payment.body));
  const contract=await f.action('save-contract',{cohortId,title:'Agreement',terms:'Program terms',amount:100});assert.equal(contract.status,200,JSON.stringify(contract.body));
  assert.equal((await f.action('request-contract-review',{id:contract.body.id})).status,200);
  const fresh=new PostgresStore({pool,workspaceId:f.workspaceId,demo:true});
  assert.equal(await fresh.run(db=>db.invoices.find(i=>i.id===invoice.body.id).payments.length),1);
});
test('poll re-ranking and survey resubmission are atomic in the SQL adapter',async()=>{
  const f=await fixture(),db=await f.store.run(db=>db),poll=db.polls[0],survey=db.surveys.find(s=>s.status==='open');
  for(const choices of [[0,1,2,3,4],[4,3,2,1,0]]){const r=await f.action('respond-poll',{id:poll.id,choices},f.participant);assert.equal(r.status,200,JSON.stringify(r.body));}
  for(const score of [3,4]){const r=await f.action('respond-survey',{id:survey.id,answers:survey.questions.map(()=>score),reflection:'Participant reflection'},f.participant);assert.equal(r.status,200,JSON.stringify(r.body));}
  const r=await f.action('confirm-poll',{id:poll.id,index:0});assert.equal(r.status,200,JSON.stringify(r.body));
  const fresh=await f.store.run(db=>db);assert.equal(fresh.polls[0].status,'confirmed');assert.equal(fresh.surveys.find(s=>s.id===survey.id).responses[0].answers[0],4);
});
test('public inquiries are deduplicated and immediately populate the coach pipeline',async()=>{
  const f=await fixture(),key=randomUUID(),inquiry={name:'New contact',email:'contact@example.test',organization:'Company',interest:'sponsor',message:'Interested',consent:true};
  const receipts=await Promise.all([f.store.saveInquiry(inquiry,key),f.store.saveInquiry(inquiry,key)]);
  assert.equal(receipts[0].reference,receipts[1].reference);assert.equal(receipts.filter(r=>r.duplicate).length,1);
  assert.equal(await f.store.run(db=>db.leads.filter(l=>l.inquiryReference===receipts[0].reference).length),1);
});
test('database rate limiting counts requests across separate function instances',async()=>{
  const f=await fixture(),other=new PostgresStore({pool,workspaceId:f.workspaceId,demo:true});
  await f.store.takeRate('same-client',1);await assert.rejects(other.takeRate('same-client',1),error=>error.status===429);
});
