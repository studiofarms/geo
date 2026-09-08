import {randomUUID,randomBytes} from 'node:crypto';
import {role,fail,hash,requireMember,find,text} from '../platform/core.mjs';
import {encrypt,decrypt,bookingURL,apiURI} from './security.mjs';
import {receiveWebhook} from './webhooks.mjs';
export class Calendly {
  /** @param {{store:any,secretKey?:string,origin?:string,fetcher?:typeof fetch,allowExternalWrites?:boolean}} options */
  constructor({store,secretKey,origin,fetcher=fetch,allowExternalWrites=true}){Object.assign(this,{store,secretKey,origin,fetcher,allowExternalWrites});}
  /** Serialize connection changes across serverless instances, including external calls. */
  async mutate(user,callback){
    role(user);if(this.store.demo)fail(409,'Live Calendly connections require a production workspace with coach sign-in.');
    await this.store.run(()=>null);
    return this.store.transaction(async client=>{const {rows:[lock]}=await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`${this.store.workspaceId}:calendly-settings`]);if(!lock.acquired)fail(409,'Another Calendly setting is being saved. Try again shortly.');return callback();});
  }
  save(user,body){return this.mutate(user,()=>this.saveConnection(user,body));}
  enableWebhook(user){return this.mutate(user,()=>this.registerWebhook(user));}
  disconnect(user){return this.mutate(user,()=>this.disconnectConnection(user));}
  /** @returns {Promise<any>} */
  async connection(){return this.store.transaction(async client=>(await client.query("SELECT * FROM gocoach.integration_connections WHERE workspace_id=$1 AND provider='calendly'",[this.store.workspaceId])).rows[0]);}
  /** @param {any} connection @param {string} name @returns {Promise<string|null>} */
  async secret(connection,name){if(!connection)return null;return this.store.transaction(async client=>{const {rows:[row]}=await client.query('SELECT encrypted_value FROM gocoach.integration_secrets WHERE workspace_id=$1 AND connection_id=$2 AND name=$3',[this.store.workspaceId,connection.id,name]);return row?decrypt(row.encrypted_value,this.secretKey,`${this.store.workspaceId}:${name}`):null;});}
  /** @param {string} path @param {string} token @param {object} options @returns {Promise<any>} */
  async api(path,token,options={}){
    const url=new URL(path,'https://api.calendly.com');
    if(url.origin!=='https://api.calendly.com'||url.username||url.password)fail(422,'Invalid Calendly API URL.');
    let response;
    try{response=await this.fetcher(url,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(12000)});}catch{fail(502,'Calendly could not be reached. Try again shortly.');}
    if(!response.ok){if([401,403].includes(response.status))fail(422,'Calendly rejected this request. Check the token scopes and whether your Calendly plan supports this feature.');if(response.status===429)fail(429,'Calendly is busy. Try again shortly.');if(response.status===404)fail(404,'This Calendly resource no longer exists.');fail(502,'Calendly could not complete this request.');}
    return response.status===204?{}:response.json();
  }
  /** @returns {Promise<object>} */
  async publicConfig(){const c=await this.connection(),s=c?.configuration||{};return {enabled:s.enabled===true,discoveryUrl:s.discoveryUrl||'',oneToOneEnabled:!!s.oneToOneUrl,connected:c?.status==='active',webhookActive:!!s.webhookUri};}
  /** @param {any} user @returns {Promise<object>} */
  async settings(user){role(user);const c=await this.connection(),s=c?.configuration||{};
    const stats=c?await this.store.transaction(async client=>(await client.query("SELECT count(*) FILTER(WHERE status='unmatched')::int AS unmatched FROM gocoach.calendly_bookings WHERE workspace_id=$1",[this.store.workspaceId])).rows[0]):{};
    return {...await this.publicConfig(),available:true,oneToOneUrl:s.oneToOneUrl||'',accountName:s.accountName||'',accountEmail:s.accountEmail||'',eventTypes:s.eventTypes||[],tokenConfigured:!!c?.credential_reference,secretStorageReady:/^[a-f\d]{64}$/i.test(this.secretKey||''),lastCheckedAt:s.lastCheckedAt||null,webhookUrl:this.origin?`${new URL(this.origin).origin}/api/webhooks/calendly`:'',webhookRegistrationAllowed:this.allowExternalWrites,unmatchedBookings:stats.unmatched||0};
  }
  /** Save and verify credentials without ever returning the token to the browser.
   * @param {any} user @param {any} body @returns {Promise<object>} */
  async saveConnection(user,body){
    role(user);await this.store.run(()=>null);
    const existing=await this.connection(),prior=existing?.configuration||{};
    const token=body.token?text(body.token,4096):await this.secret(existing,'calendly-token');
    const discoveryUrl=bookingURL(body.discoveryUrl,true),oneToOneUrl=bookingURL(body.oneToOneUrl,true);
    if(body.enabled===true&&!discoveryUrl)fail(422,'Add a discovery event link before enabling Calendly.');
    if(discoveryUrl&&oneToOneUrl&&discoveryUrl===oneToOneUrl)fail(422,'Use separate Calendly event types for discovery calls and participant 1:1s.');
    let configuration={...prior,enabled:body.enabled===true,discoveryUrl,oneToOneUrl};
    if(token){
      // Validate encryption configuration before contacting Calendly.
      encrypt(token,this.secretKey,`${this.store.workspaceId}:calendly-token`);
      const {resource:account}=await this.api('/users/me',token);
      apiURI(account.uri,'users');apiURI(account.current_organization,'organizations');
      if(prior.webhookUri&&prior.userUri!==account.uri)fail(409,'Disconnect the current Calendly account before switching accounts.');
      const eventTypes=[];let page,pages=0;
      do{const result=await this.api(`/event_types?user=${encodeURIComponent(account.uri)}&active=true&count=100${page?`&page_token=${encodeURIComponent(page)}`:''}`,token);
        eventTypes.push(...(result.collection||[]).map(e=>({uri:apiURI(e.uri,'event_types'),name:e.name,url:bookingURL(e.scheduling_url),duration:e.duration})));
        page=result.pagination?.next_page_token;
        if(eventTypes.length>1000||++pages>=10&&page)fail(422,'This Calendly account has too many event types to configure here.');
      }while(page);
      for(const url of [discoveryUrl,oneToOneUrl].filter(Boolean))if(!eventTypes.some(e=>e.url===url))fail(422,'Choose an active event link belonging to the connected Calendly account.');
      const discovery=eventTypes.find(e=>e.url===discoveryUrl);
      if(discovery&&discovery.duration!==30)fail(422,'The discovery event must be 30 minutes in Calendly.');
      configuration={...configuration,userUri:account.uri,organizationUri:account.current_organization,accountName:account.name,accountEmail:account.email,eventTypes,discoveryEventUri:discovery?.uri||null,oneToOneEventUri:eventTypes.find(e=>e.url===oneToOneUrl)?.uri||null,lastCheckedAt:new Date().toISOString()};
    }
    const connectionId=existing?.id||randomUUID();
    await this.store.transaction(async client=>{
      await client.query("INSERT INTO gocoach.integration_connections(workspace_id,id,user_id,provider,kind,status,credential_reference,configuration) VALUES($1,$2,$3,'calendly','calendar',$4,$5,$6) ON CONFLICT(workspace_id,id) DO UPDATE SET user_id=EXCLUDED.user_id,status=EXCLUDED.status,credential_reference=EXCLUDED.credential_reference,configuration=EXCLUDED.configuration,updated_at=now()",[this.store.workspaceId,connectionId,user.id,token?'active':'not-connected',token?'encrypted:calendly-token':null,configuration]);
      if(token)await client.query("INSERT INTO gocoach.integration_secrets(workspace_id,connection_id,name,encrypted_value) VALUES($1,$2,'calendly-token',$3) ON CONFLICT(workspace_id,connection_id,name) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,updated_at=now()",[this.store.workspaceId,connectionId,encrypt(token,this.secretKey,`${this.store.workspaceId}:calendly-token`)]);
      await client.query("INSERT INTO gocoach.audit_events(workspace_id,actor_id,action,entity_type,entity_id) VALUES($1,$2,'calendly.settings.saved','integration',$3)",[this.store.workspaceId,user.id,connectionId]);
    });
    return this.settings(user);
  }
  /** @param {any} user @returns {Promise<object>} */
  async registerWebhook(user){
    role(user);if(!this.allowExternalWrites)fail(409,'Enable booking sync from the production site, not a deploy preview.');
    const c=await this.connection(),s=c?.configuration||{},token=await this.secret(c,'calendly-token');
    if(!token||!s.discoveryEventUri)fail(422,'Connect and save a discovery event before enabling booking sync.');
    if(!this.origin||!this.origin.startsWith('https://'))fail(422,'Booking sync needs a deployed HTTPS website.');
    if(s.webhookUri)return this.settings(user);
    const previousKey=await this.secret(c,'calendly-webhook-key');
    const signingKey=previousKey||randomBytes(32).toString('hex'),callback=`${new URL(this.origin).origin}/api/webhooks/calendly`;
    if(s.webhookUrl&&s.webhookUrl!==callback)fail(409,'Disconnect booking sync before changing the public site address.');
    // Persist the signing key first, so the receiver can verify an immediate event.
    await this.store.transaction(client=>client.query("INSERT INTO gocoach.integration_secrets(workspace_id,connection_id,name,encrypted_value) VALUES($1,$2,'calendly-webhook-key',$3) ON CONFLICT(workspace_id,connection_id,name) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,updated_at=now()",[this.store.workspaceId,c.id,encrypt(signingKey,this.secretKey,`${this.store.workspaceId}:calendly-webhook-key`)]));
    await this.store.transaction(client=>client.query('UPDATE gocoach.integration_connections SET configuration=configuration||$3::jsonb WHERE workspace_id=$1 AND id=$2',[this.store.workspaceId,c.id,JSON.stringify({webhookUrl:callback})]));
    // Recover an earlier successful POST whose response was lost. Reuse its signing key.
    const recovered=previousKey?await this.findWebhook(s,token,callback):null;
    const resource=recovered||(await this.api('/webhook_subscriptions',token,{method:'POST',body:JSON.stringify({url:callback,events:['invitee.created','invitee.canceled'],organization:s.organizationUri,user:s.userUri,scope:'user',signing_key:signingKey})})).resource;
    const webhookUri=apiURI(resource.uri,'webhook_subscriptions');
    await this.store.transaction(client=>client.query("UPDATE gocoach.integration_connections SET configuration=configuration||$3::jsonb,updated_at=now() WHERE workspace_id=$1 AND id=$2",[this.store.workspaceId,c.id,JSON.stringify({webhookUri,webhookUrl:callback})]));
    return this.settings(user);
  }
  /** @param {any} user @returns {Promise<object>} */
  async findWebhook(s,token,callback){
    let page,pages=0;
    do{const result=await this.api(`/webhook_subscriptions?organization=${encodeURIComponent(s.organizationUri)}&user=${encodeURIComponent(s.userUri)}&scope=user&count=100${page?`&page_token=${encodeURIComponent(page)}`:''}`,token);
      const found=(result.collection||[]).find(w=>w.callback_url===callback&&w.state==='active');if(found)return found;
      page=result.pagination?.next_page_token;if(++pages>=10&&page)fail(422,'Too many Calendly webhooks to reconcile.');
    }while(page);return null;
  }
  async disconnectConnection(user){role(user);const c=await this.connection();if(!c)return this.settings(user);
    const s=c.configuration,token=await this.secret(c,'calendly-token');
    if(s.webhookUri||s.webhookUrl){if(!this.allowExternalWrites)fail(409,'Disconnect the webhook from the production site.');
      const webhookUri=s.webhookUri||(await this.findWebhook(s,token,s.webhookUrl))?.uri;
      if(webhookUri)try{await this.api(apiURI(webhookUri,'webhook_subscriptions'),token,{method:'DELETE'});}catch(error){if(error.status!==404)throw error;}}
    await this.store.transaction(async client=>{
      await client.query('DELETE FROM gocoach.integration_secrets WHERE workspace_id=$1 AND connection_id=$2',[this.store.workspaceId,c.id]);
      await client.query("UPDATE gocoach.integration_connections SET status='revoked',credential_reference=NULL,configuration=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2",[this.store.workspaceId,c.id,{enabled:false,discoveryUrl:s.discoveryUrl,oneToOneUrl:s.oneToOneUrl}]);
    });return this.settings(user);
  }
  /** @param {any} user @param {string} cohortId @returns {Promise<{url:string}>} */
  async participantLink(user,cohortId){role(user,['participant']);const c=await this.connection(),s=c?.configuration||{};
    if(!s.enabled||!s.oneToOneUrl)fail(409,'Your coach has not enabled Calendly 1:1 booking yet.');
    const token=randomBytes(32).toString('hex');
    await this.store.run(async(db,client)=>{requireMember(db,user,cohortId);find(db.cohorts,cohortId);
      await client.query("INSERT INTO gocoach.booking_contexts(workspace_id,token_hash,cohort_id,participant_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours')",[this.store.workspaceId,hash(token),cohortId,user.id]);});
    const url=new URL(s.oneToOneUrl);url.searchParams.set('name',user.name);url.searchParams.set('email',user.email);url.searchParams.set('utm_source','gocoach');url.searchParams.set('utm_content',token);
    return {url:url.href};
  }
  /** @param {Buffer} raw @param {string|null} signature @returns {Promise<object>} */
  receiveWebhook(raw,signature){return receiveWebhook(this,raw,signature);}
}
