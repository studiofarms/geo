import {randomUUID,randomBytes} from 'node:crypto';
import {role,fail,text,email,find,hash} from '../platform/core.mjs';
import {encrypt,decrypt} from '../calendly/security.mjs';
import {ZoomClient,joinURL,meetingId} from './client.mjs';
export const sessionFingerprint=s=>hash(JSON.stringify([s.title,s.startsAt,s.duration,s.status]));
/** One direct Zoom host per workspace, for sessions scheduled inside GoCoach. */
export class Zoom {
  constructor({store,secretKey,fetcher=fetch,allowExternalWrites=true}){Object.assign(this,{store,secretKey,allowExternalWrites});this.client=new ZoomClient(fetcher);}
  connection(){return this.store.transaction(async client=>(await client.query("SELECT * FROM gocoach.integration_connections WHERE workspace_id=$1 AND provider='zoom'",[this.store.workspaceId])).rows[0]);}
  credentials(c){return this.store.transaction(async client=>{if(!c)return null;const {rows:[row]}=await client.query("SELECT encrypted_value FROM gocoach.integration_secrets WHERE workspace_id=$1 AND connection_id=$2 AND name='zoom-credentials'",[this.store.workspaceId,c.id]);return row?JSON.parse(decrypt(row.encrypted_value,this.secretKey,`${this.store.workspaceId}:zoom-credentials`)):null;});}
  async mutate(user,callback){
    role(user);if(this.store.demo)fail(409,'Live Zoom connections require a production workspace with coach sign-in.');
    if(!this.allowExternalWrites)fail(409,'Manage Zoom from the production site, not a deploy preview.');
    await this.store.run(()=>null);
    return this.store.transaction(async client=>{const {rows:[lock]}=await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`${this.store.workspaceId}:zoom`]);if(!lock.acquired)fail(409,'Another Zoom request is in progress. Try again shortly.');return callback();});
  }
  async settings(user){
    role(user);const c=await this.connection(),s=c?.configuration||{};
    const meetings=await this.store.transaction(async client=>(await client.query("SELECT session_id,status,synced_hash FROM gocoach.zoom_meetings WHERE workspace_id=$1 AND status<>'deleted'",[this.store.workspaceId])).rows);
    return {available:true,connected:c?.status==='active',secretStorageReady:/^[a-f\d]{64}$/i.test(this.secretKey||''),accountId:s.accountId||'',clientId:s.clientId||'',hostEmail:s.hostEmail||'',hostName:s.hostName||'',secretConfigured:!!c?.credential_reference,operationsAllowed:this.allowExternalWrites,waitingRoom:s.waitingRoom!==false,meetings:meetings.map(m=>({sessionId:m.session_id,status:m.status,syncedHash:m.synced_hash}))};
  }
  save(user,body){return this.mutate(user,async()=>{
    const c=await this.connection(),old=await this.credentials(c),accountId=text(body.accountId,200),clientId=text(body.clientId,200),hostEmail=email(body.hostEmail);
    const clientSecret=body.clientSecret?text(body.clientSecret,500):old?.clientSecret;
    if(!clientSecret)fail(422,'Paste the Zoom client secret.');
    const credentials={accountId,clientId,clientSecret};
    const encrypted=encrypt(JSON.stringify(credentials),this.secretKey,`${this.store.workspaceId}:zoom-credentials`);
    const token=await this.client.token(credentials),host=await this.client.api(`/users/${encodeURIComponent(hostEmail)}`,token);
    if(!host.id||host.status!=='active')fail(422,'Choose an active Zoom host account.');
    if(c?.configuration.hostId&&(c.configuration.hostId!==host.id||c.configuration.accountId!==accountId)){
      const settings=await this.settings(user);if(settings.meetings.length)fail(409,'Remove the existing GoCoach Zoom meetings before changing host accounts.');
    }
    const id=c?.id||randomUUID(),configuration={accountId,clientId,hostId:host.id,hostEmail:host.email,hostName:[host.first_name,host.last_name].filter(Boolean).join(' '),waitingRoom:body.waitingRoom!==false,lastCheckedAt:new Date().toISOString()};
    await this.store.transaction(async client=>{
      await client.query("INSERT INTO gocoach.integration_connections(workspace_id,id,user_id,provider,kind,status,credential_reference,configuration) VALUES($1,$2,$3,'zoom','video','active','encrypted:zoom-credentials',$4) ON CONFLICT(workspace_id,id) DO UPDATE SET status='active',credential_reference=EXCLUDED.credential_reference,configuration=EXCLUDED.configuration,updated_at=now()",[this.store.workspaceId,id,user.id,configuration]);
      await client.query("INSERT INTO gocoach.integration_secrets(workspace_id,connection_id,name,encrypted_value) VALUES($1,$2,'zoom-credentials',$3) ON CONFLICT(workspace_id,connection_id,name) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,updated_at=now()",[this.store.workspaceId,id,encrypted]);
      await client.query("INSERT INTO gocoach.audit_events(workspace_id,actor_id,action,entity_type,entity_id) VALUES($1,$2,'zoom.settings.saved','integration',$3)",[this.store.workspaceId,user.id,id]);
    });return this.settings(user);
  });}
  disconnect(user){return this.mutate(user,async()=>{
    const c=await this.connection();if(c)await this.store.transaction(async client=>{
      await client.query("DELETE FROM gocoach.integration_secrets WHERE workspace_id=$1 AND connection_id=$2 AND name='zoom-credentials'",[this.store.workspaceId,c.id]);
      await client.query("UPDATE gocoach.integration_connections SET status='revoked',credential_reference=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",[this.store.workspaceId,c.id]);
    });return this.settings(user);
  });}
  /** Creates once, reconciles ambiguous retries, or pushes a changed session to Zoom. */
  sync(user,sessionId,remove=false){return this.mutate(user,async()=>{
    const c=await this.connection(),credentials=await this.credentials(c);if(c?.status!=='active'||!credentials)fail(409,'Connect Zoom in Settings first.');
    const session=await this.store.run(db=>find(db.sessions,sessionId));
    if(session.provider==='calendly')fail(409,'Calendly manages this meeting. Select Zoom as its event location in Calendly.');
    if(!remove&&session.status!=='scheduled')fail(409,'Schedule this session before creating or syncing its Zoom meeting.');
    const {rows:[prior]}=await this.store.transaction(client=>client.query('SELECT * FROM gocoach.zoom_meetings WHERE workspace_id=$1 AND session_id=$2',[this.store.workspaceId,sessionId]));
    const reference=`GoCoach session ${this.store.workspaceId}/${sessionId}`,token=await this.client.token(credentials);
    let id=prior?.status!=='deleted'?prior?.meeting_id:null,meeting;
    if(prior?.status==='pending'&&!id){meeting=await this.client.findMeeting(c.configuration.hostId,reference,token);if(!meeting)fail(409,'The earlier request has an uncertain result. Check Zoom before retrying; a second meeting has not been created.');id=meetingId(meeting.id);}
    if(remove){
      if(id)try{await this.client.api(`/meetings/${id}`,token,'DELETE');}catch(error){if(error.status!==404)throw error;}
      await this.store.run(async(db,client)=>{find(db.sessions,sessionId).meetingUrl='';await client.query("UPDATE gocoach.zoom_meetings SET status='deleted',updated_at=now() WHERE workspace_id=$1 AND session_id=$2",[this.store.workspaceId,sessionId]);},true);
      return {id:sessionId,removed:true};
    }
    const body={topic:session.title,start_time:new Date(session.startsAt).toISOString().replace('.000Z','Z'),duration:session.duration,timezone:session.timeZone||'UTC',agenda:reference};
    if(!id){
      if(session.meetingUrl)fail(409,'This session already has a meeting link. Remove it before creating a new Zoom meeting.');
      await this.store.transaction(client=>client.query("INSERT INTO gocoach.zoom_meetings(workspace_id,session_id,connection_id,status) VALUES($1,$2,$3,'pending') ON CONFLICT(workspace_id,session_id) DO UPDATE SET meeting_id=NULL,status='pending',connection_id=EXCLUDED.connection_id,updated_at=now()",[this.store.workspaceId,sessionId,c.id]));
      try{meeting=await this.client.api(`/users/${encodeURIComponent(c.configuration.hostId)}/meetings`,token,'POST',{...body,type:2,password:randomBytes(5).toString('hex'),settings:{join_before_host:false,waiting_room:c.configuration.waitingRoom!==false,auto_recording:'none'}});}
      catch(error){if([422,404,429].includes(error.status))await this.store.transaction(client=>client.query("DELETE FROM gocoach.zoom_meetings WHERE workspace_id=$1 AND session_id=$2 AND meeting_id IS NULL",[this.store.workspaceId,sessionId]));throw error;}
      id=meetingId(meeting.id);
    }else{
      await this.client.api(`/meetings/${id}`,token,'PATCH',body);
      meeting=await this.client.api(`/meetings/${id}`,token);
    }
    const url=joinURL(meeting.join_url);
    // Retain the provider ID before attaching the link, so an interrupted save is recoverable.
    await this.store.transaction(client=>client.query("UPDATE gocoach.zoom_meetings SET meeting_id=$3,status='active',synced_hash=$4,updated_at=now() WHERE workspace_id=$1 AND session_id=$2",[this.store.workspaceId,sessionId,id,sessionFingerprint(session)]));
    await this.store.run(db=>{const current=find(db.sessions,sessionId);if(sessionFingerprint(current)!==sessionFingerprint(session))fail(409,'The session changed while Zoom was updating. Sync again to apply the latest details.');current.meetingUrl=url;db.audit.push({id:randomUUID(),userId:user.id,action:'zoom.meeting.synced',recordId:sessionId,at:new Date().toISOString()});},true);
    return {id:sessionId,synced:true};
  });}
}
