import { randomUUID } from 'node:crypto';
import { seed } from '../platform/seed.mjs';
import { hash, fail } from '../platform/core.mjs';
import { decode, tables } from './codec.mjs';
import { stableId } from './rows.mjs';
import { writeState } from './write.mjs';
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
/** @param {any} input @param {string} workspace @returns {{db:any,mapping:Map<string,string>}} */
function demoSeed(input,workspace){
  const mapping=new Map();
  const collect=value=>{if(!value||typeof value!=='object')return;if(value.id&&!uuid.test(value.id))mapping.set(value.id,stableId(`${workspace}:${value.id}`));for(const child of Object.values(value))collect(child);};collect(input);
  const replace=value=>typeof value==='string'?(mapping.get(value)||value):Array.isArray(value)?value.map(replace):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)])):value;
  const db=replace(input);db.primaryCoachId=mapping.get('coach-demo');
  db.demoUsers=Object.fromEntries(['coach','buyer','participant'].map(role=>[role,mapping.get(`${role}-demo`)]));
  db.pendingFiles=db.documents.map(d=>{const contents=Buffer.from(d.inlineContent);delete d.inlineContent;d.size=contents.length;return {id:d.id,base64:contents.toString('base64')};});
  return {db,mapping};
}
/** PostgreSQL-backed unit of work. No process-local data cache or filesystem writes.
 * One workspace mutation at a time preserves the existing domain transaction API.
 * @param {any} client @param {string} workspace @returns {Promise<any>} */
async function loadState(client,workspace){
  const {rows:[w]}=await client.query('SELECT * FROM gocoach.workspaces WHERE id=$1',[workspace]);
  const {rows:[preferences]}=await client.query('SELECT settings FROM gocoach.workspace_settings WHERE workspace_id=$1',[workspace]);
  const fields=tables.map(table=>`'${table}',(SELECT coalesce(jsonb_agg(t ORDER BY to_jsonb(t)->>'created_at',to_jsonb(t)::text),'[]'::jsonb) FROM gocoach.${table} t WHERE workspace_id=$1)`);
  const {rows:[result]}=await client.query(`SELECT jsonb_build_object(${fields.join(',')}) AS data`,[workspace]);
  return decode(result.data,w,preferences?.settings||seed(false).settings);
}
export class PostgresStore {
  /** @param {{pool:any,workspaceId:string,demo?:boolean,allowEmpty?:boolean,bootstrap?:{email:string,name:string,passwordHash:string}}} options */
  constructor({pool,workspaceId,demo=false,bootstrap,allowEmpty=false}){
    if(!uuid.test(workspaceId))throw new Error('GOCOACH_WORKSPACE_ID must be a UUID');
    this.pool=pool;this.workspaceId=workspaceId;this.demo=demo;this.bootstrap=bootstrap;this.allowEmpty=allowEmpty;this.database=true;
  }
  /** @param {any} client @returns {Promise<void>} */
  async initialize(client){
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`gocoach:${this.workspaceId}`]);
    const {rows}=await client.query('SELECT demo FROM gocoach.workspaces WHERE id=$1 FOR UPDATE',[this.workspaceId]);
    if(rows.length){if(rows[0].demo!==this.demo)fail(503,'Workspace mode differs from deployment settings. Use a separate workspace for demo data.','workspace-mode-mismatch');return;}
    if(!this.demo&&!this.bootstrap&&!this.allowEmpty)fail(503,'Configure the initial coach account before opening the production workspace.','coach-account-missing');
    await client.query('INSERT INTO gocoach.workspaces(id,slug,name,demo) VALUES($1,$2,$3,$4)',[this.workspaceId,`gocoach-${this.workspaceId}`,'GoCoach',this.demo]);
    const {db,mapping}=this.demo?demoSeed(seed(true),this.workspaceId):{db:seed(false),mapping:new Map()};
    if(!this.demo&&this.bootstrap){const {email,name,passwordHash}=this.bootstrap;
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!name||!/^([a-f\d]{32}):([a-f\d]{128})$/.test(passwordHash))fail(503,'Invalid bootstrap account configuration','bootstrap-account-invalid');
      db.users.push({id:randomUUID(),name,email:email.toLowerCase(),role:'coach',passwordHash});}
    await writeState(client,this.workspaceId,seed(false),db);
    await client.query('INSERT INTO gocoach.workspace_settings(workspace_id,settings) VALUES($1,$2) ON CONFLICT DO NOTHING',[this.workspaceId,db.settings]);
    for(const [legacy,newId]of mapping)await client.query('INSERT INTO gocoach.legacy_id_map(workspace_id,entity_type,legacy_id,new_id) VALUES($1,$2,$3,$4)',[this.workspaceId,'demo',legacy,newId]);
  }
  /** @param {(db:any)=>any|Promise<any>} callback @param {boolean} mutate @returns {Promise<any>} */
  async run(callback,mutate=false){
    return this.transaction(async client=>{
      await this.initialize(client);
      const db=await loadState(client,this.workspaceId),before=structuredClone(db);
      const result=await callback(db,client);
      if(mutate)await writeState(client,this.workspaceId,before,db);
      return result;
    });
  }
  /** @param {(client:any)=>any|Promise<any>} callback @returns {Promise<any>} */
  async transaction(callback){
    for(let attempt=0;attempt<3;attempt++){
      const client=await this.pool.connect();
      try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='20s'");
        await client.query("SELECT set_config('gocoach.workspace_id',$1,true),set_config('gocoach.user_id','',true)",[this.workspaceId]);
        const result=await callback(client);await client.query('COMMIT');return result;
      }catch(error){await client.query('ROLLBACK').catch(()=>{});
        if(['40001','40P01'].includes(error.code)&&attempt<2){await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));continue;}
        if(['23505','23514','23P01','23503'].includes(error.code))fail(409,'This change conflicts with an existing record or schedule. Refresh and try again.');throw error;
      }finally{client.release();}
    }
  }
  /** @param {string} id @returns {Promise<Buffer>} */
  async readFile(id){return this.transaction(async client=>{const {rows}=await client.query('SELECT contents FROM gocoach.file_contents WHERE workspace_id=$1 AND file_id=$2',[this.workspaceId,id]);if(!rows.length)fail(404,'File not found.');return rows[0].contents;});}
  /** @param {string} key @param {number} limit @param {number} seconds @returns {Promise<void>} */
  async takeRate(key,limit,seconds=60){return this.transaction(async client=>{
    await this.initialize(client);
    const {rows:[r]}=await client.query(`INSERT INTO gocoach.rate_limit_buckets(workspace_id,key,attempts,expires_at) VALUES($1,$2,1,now()+$3*interval '1 second')
      ON CONFLICT(workspace_id,key) DO UPDATE SET attempts=CASE WHEN gocoach.rate_limit_buckets.expires_at<=now() THEN 1 ELSE gocoach.rate_limit_buckets.attempts+1 END,
      expires_at=CASE WHEN gocoach.rate_limit_buckets.expires_at<=now() THEN EXCLUDED.expires_at ELSE gocoach.rate_limit_buckets.expires_at END RETURNING attempts`,[this.workspaceId,hash(key),seconds]);
    return r.attempts;
  }).then(count=>{if(count>limit)fail(429,'Too many requests. Please try again shortly.');});}
  /** @param {any} inquiry @param {string} requestKey @returns {Promise<any>} */
  async saveInquiry(inquiry,requestKey){
    if(!uuid.test(requestKey))fail(400,'Please refresh the page and try again.');
    return this.transaction(async client=>{await this.initialize(client);
      const fingerprint=hash(JSON.stringify(inquiry)),{rows:[prior]}=await client.query('SELECT reference,request_hash FROM gocoach.inquiries WHERE workspace_id=$1 AND request_key=$2',[this.workspaceId,requestKey]);
      if(prior){if(prior.request_hash!==fingerprint)fail(409,'This inquiry request has already been used.');return {reference:prior.reference,duplicate:true};}
      const id=randomUUID(),reference=`GC-${randomUUID().slice(0,8).toUpperCase()}`;
      await client.query('INSERT INTO gocoach.inquiries(workspace_id,id,reference,request_key,request_hash,name,email,organization,interest,message,consent_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())',[this.workspaceId,id,reference,requestKey,fingerprint,inquiry.name,inquiry.email,inquiry.organization,inquiry.interest,inquiry.message]);
      await client.query('INSERT INTO gocoach.leads(workspace_id,inquiry_id,inquiry_reference,name,email,company,note) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.workspaceId,id,reference,inquiry.name,inquiry.email,inquiry.organization,inquiry.message]);
      return {reference,duplicate:false};
    });
  }
}
