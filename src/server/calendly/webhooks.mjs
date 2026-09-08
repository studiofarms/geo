import {randomUUID} from 'node:crypto';
import {verifySignature,apiURI} from './security.mjs';
import {hash,fail,notify,coaches,meetingURL} from '../platform/core.mjs';
const safeLink=value=>{try{const u=new URL(value);return u.origin==='https://calendly.com'&&!u.username&&!u.password?u.href:null;}catch{return null;}};
/** Verify, deduplicate and transactionally reconcile a Calendly event.
 * @param {any} service @param {Buffer} raw @param {string|null} signature @returns {Promise<object>} */
export async function receiveWebhook(service,raw,signature){
  const c=await service.connection(),key=await service.secret(c,'calendly-webhook-key');
  if(!key||!verifySignature(raw,signature,key))fail(401,'Invalid Calendly signature.');
  let event;try{event=JSON.parse(raw.toString('utf8'));}catch{fail(400,'Invalid webhook body.');}
  if(!['invitee.created','invitee.canceled'].includes(event.event))return {ignored:true};
  const p=event.payload;if(!p||!/^https:\/\/api\.calendly\.com\/scheduled_events\/[A-Za-z0-9-]+\/invitees\/[A-Za-z0-9-]+$/.test(p.uri||''))fail(400,'Invalid Calendly invitee.');
  const eventUri=apiURI(typeof p.event==='string'?p.event:p.scheduled_event?.uri,'scheduled_events');
  const token=await service.secret(c,'calendly-token');
  if(!token)fail(409,'Calendly is disconnected.');
  const {resource:scheduled}=await service.api(eventUri,token),s=c.configuration;
  const kind=scheduled.event_type===s.discoveryEventUri?'discovery':scheduled.event_type===s.oneToOneEventUri?'one-to-one':null;
  if(!kind)return {ignored:true};
  const updated=p.updated_at||event.created_at||scheduled.updated_at;
  if(!Number.isFinite(Date.parse(updated)))fail(400,'Webhook timestamp missing.');
  const eventKey=hash(`${event.event}:${p.uri}:${updated}`),workspace=service.store.workspaceId;
  return service.store.run(async(db,client)=>{
    const {rows:[duplicate]}=await client.query('SELECT id FROM gocoach.webhook_events WHERE workspace_id=$1 AND connection_id=$2 AND external_event_id=$3',[workspace,c.id,eventKey]);
    if(duplicate)return {duplicate:true};
    const {rows:[previous]}=await client.query('SELECT * FROM gocoach.calendly_bookings WHERE workspace_id=$1 AND invitee_uri=$2',[workspace,p.uri]);
    const canceled=event.event==='invitee.canceled'||p.status==='canceled'||scheduled.status==='canceled';
    let state='processed',sessionId=previous?.session_id||null;
    if(previous&&(Date.parse(previous.provider_updated_at)>Date.parse(updated)||(previous.status==='canceled'&&!canceled)))state='ignored';
    else if(canceled){const session=db.sessions.find(s=>s.id===sessionId);if(session){session.status='cancelled';notify(db,[...coaches(db),...(session.participantId?[session.participantId]:[])],'Calendly booking cancelled',session.title,'sessions');}}
    else if(!sessionId){
      let bookingContext,oldSession;
      if(p.old_invitee){const {rows:[old]}=await client.query('SELECT session_id FROM gocoach.calendly_bookings WHERE workspace_id=$1 AND invitee_uri=$2',[workspace,String(p.old_invitee)]);oldSession=db.sessions.find(session=>session.id===old?.session_id&&session.provider==='calendly');}
      if(kind==='one-to-one'){
        const tracking=p.tracking?.utm_content;
        if(tracking){const {rows:[context]}=await client.query('SELECT * FROM gocoach.booking_contexts WHERE workspace_id=$1 AND token_hash=$2 AND expires_at>now()',[workspace,hash(String(tracking))]);bookingContext=context;}
        if(!bookingContext&&oldSession?.participantId)bookingContext={cohort_id:oldSession.cohortId,participant_id:oldSession.participantId};
        const user=db.users.find(u=>u.id===bookingContext?.participant_id);
        if(!bookingContext||!user||user.email.toLowerCase()!==String(p.email).toLowerCase()||!db.enrollments.some(e=>e.cohortId===bookingContext.cohort_id&&e.userId===user.id&&['enrolled','completed'].includes(e.status)))state='received';
      }
      const duration=(Date.parse(scheduled.end_time)-Date.parse(scheduled.start_time))/60000;
      if(!Number.isInteger(duration)||duration<15||duration>180)fail(422,'Unsupported Calendly event duration.');
      const conflicts=db.sessions.some(session=>session.id!==oldSession?.id&&session.status==='scheduled'&&session.coachId===c.user_id&&Date.parse(session.startsAt)<Date.parse(scheduled.end_time)&&Date.parse(session.startsAt)+session.duration*60000>Date.parse(scheduled.start_time));
      if(conflicts)state='received';
      if(state==='processed'){
        if(oldSession){oldSession.status='cancelled';await client.query("UPDATE gocoach.calendly_bookings SET status='canceled' WHERE workspace_id=$1 AND invitee_uri=$2",[workspace,String(p.old_invitee)]);}
        sessionId=randomUUID();const name=String(p.name||'Calendly guest').slice(0,100),email=String(p.email||'').toLowerCase();
        const session={id:sessionId,coachId:c.user_id,cohortId:bookingContext?.cohort_id||null,participantId:bookingContext?.participant_id||null,kind,title:`${kind==='discovery'?'Discovery':'1:1'} / ${name}`,status:'scheduled',startsAt:new Date(scheduled.start_time).toISOString(),duration,timeZone:db.settings.timeZone,meetingUrl:meetingURL(scheduled.location?.join_url||''),materials:'',summary:'',privateNotes:'',provider:'calendly',rescheduleUrl:safeLink(p.reschedule_url),cancelUrl:safeLink(p.cancel_url),contact:{name,email},createdAt:new Date().toISOString()};
        db.sessions.push(session);
        if(kind==='discovery')db.leads.push({id:randomUUID(),name,email,company:'',note:'Booked through Calendly.',stage:'discovery',value:0,sessionId,createdAt:session.createdAt});
        notify(db,[...coaches(db),...(session.participantId?[session.participantId]:[])],'Calendly booking confirmed',session.title,'sessions');
      }else notify(db,coaches(db),'Calendly booking needs attention',conflicts?'A Calendly booking overlaps an existing session. Review the schedule in Calendly.':'A participant booked without a matching cohort link. Review the booking in Calendly.','integrations');
    }
    if(state!=='ignored')await client.query(`INSERT INTO gocoach.calendly_bookings(workspace_id,invitee_uri,event_uri,session_id,status,provider_updated_at) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(workspace_id,invitee_uri) DO UPDATE SET session_id=EXCLUDED.session_id,status=EXCLUDED.status,provider_updated_at=EXCLUDED.provider_updated_at`,[workspace,p.uri,eventUri,sessionId,canceled?'canceled':sessionId?'active':'unmatched',updated]);
    await client.query('INSERT INTO gocoach.webhook_events(workspace_id,connection_id,external_event_id,kind,payload,status,signature_verified_at,processed_at) VALUES($1,$2,$3,$4,$5,$6,now(),now())',[workspace,c.id,eventKey,event.event,{inviteeUri:p.uri,eventUri,providerUpdatedAt:updated},state]);
    return {received:true,status:state};
  },true);
}
