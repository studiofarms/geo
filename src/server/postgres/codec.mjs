import { seed } from '../platform/seed.mjs';
export const iso = value => value ? new Date(value).toISOString() : undefined;
export const day = value => value ? new Date(value).toISOString().slice(0,10) : null;
export const num = value => { const n=Number(value); if (!Number.isSafeInteger(n)) throw new Error('Unsafe database integer'); return n; };
export const tables = ['buyers','users','user_credentials','auth_sessions','cohorts','enrollments','invitations','sessions','session_contacts','session_private_notes','buyer_private_notes','leads','subscribers','availability_polls','poll_slots','poll_responses','poll_choices','documents','file_objects','reports','surveys','survey_questions','survey_responses','survey_answers','invoices','payments','contracts','contract_acknowledgements','notifications','messages','email_deliveries','outbox_events','audit_events','reminder_receipts','idempotency_requests','legacy_id_map'];
const base = r => ({id:r.id,createdAt:iso(r.created_at)});
/** Convert normalized SQL records to the current API's domain objects.
 * @param {Record<string,any[]>} data @param {any} workspace @param {any} settings @returns {any} */
export function decode(data, workspace, settings) {
  const db=seed(false); db.demo=workspace.demo; db.createdAt=iso(workspace.created_at); db.settings=settings;
  const list=name=>data[name]||[], related=(name,key,id)=>list(name).filter(r=>r[key]===id);
  db.users=list('users').map(r=>({...base(r),name:r.name,email:r.email,role:r.role,buyerId:r.buyer_id||undefined,active:r.active,
    passwordHash:list('user_credentials').find(c=>c.user_id===r.id)?.password_hash||''}));
  db.primaryCoachId=db.users.find(u=>u.role==='coach'&&u.active)?.id;
  db.demoUsers=Object.fromEntries(['coach','buyer','participant'].map(role=>[role,list('legacy_id_map').find(r=>r.legacy_id===`${role}-demo`)?.new_id]));
  db.authSessions=list('auth_sessions').filter(r=>!r.revoked_at).map(r=>({...base(r),userId:r.user_id,hash:r.token_hash,expiresAt:Date.parse(r.expires_at)}));
  db.buyers=list('buyers').map(r=>({...base(r),company:r.company,contact:r.contact_name,email:r.contact_email,billingEmail:r.billing_email,billingAddress:r.billing_address,
    notes:related('buyer_private_notes','buyer_id',r.id).map(n=>n.body).join('\n')}));
  db.cohorts=list('cohorts').map(r=>({...base(r),buyerId:r.buyer_id,name:r.name,description:r.description,startDate:iso(r.starts_on),endDate:iso(r.ends_on),timeZone:r.time_zone,capacity:r.capacity,price:num(r.price_minor),status:r.status,currency:r.currency}));
  db.enrollments=list('enrollments').map(r=>({...base(r),cohortId:r.cohort_id,userId:r.participant_id,status:r.status}));
  db.invitations=list('invitations').filter(r=>!r.revoked_at).map(r=>({...base(r),userId:r.user_id,cohortId:r.cohort_id,hash:r.token_hash,expiresAt:Date.parse(r.expires_at),acceptedAt:iso(r.accepted_at)}));
  db.sessions=list('sessions').map(r=>{const contact=related('session_contacts','session_id',r.id)[0];return {...base(r),cohortId:r.cohort_id,participantId:r.participant_id,coachId:r.coach_id,title:r.title,kind:r.kind,status:r.status,startsAt:iso(r.starts_at),duration:r.duration_minutes,timeZone:r.time_zone,meetingUrl:r.meeting_url||'',materials:r.materials,summary:r.summary,cancellationHash:r.cancellation_hash||undefined,
    provider:r.provider||'local',rescheduleUrl:r.reschedule_url||null,cancelUrl:r.cancel_url||null,
    privateNotes:related('session_private_notes','session_id',r.id).map(n=>n.body).join('\n'),...(contact?{contact:{name:contact.name,email:contact.email}}:{})};});
  db.leads=list('leads').map(r=>({...base(r),name:r.name,email:r.email,company:r.company,stage:r.stage,value:num(r.value_minor),note:r.note,inquiryReference:r.inquiry_reference||undefined,sessionId:list('sessions').find(s=>s.lead_id===r.id)?.id}));
  db.subscribers=list('subscribers').map(r=>({...base(r),email:r.email,status:r.status,consentAt:iso(r.consent_at),unsubscribedAt:iso(r.unsubscribed_at),tokenHash:r.unsubscribe_hash}));
  db.polls=list('availability_polls').map(r=>{const slots=related('poll_slots','poll_id',r.id).sort((a,b)=>a.position-b.position);return {...base(r),cohortId:r.cohort_id,title:r.title,deadline:iso(r.deadline),status:r.status,slots:slots.map(s=>iso(s.starts_at)),slotIds:slots.map(s=>s.id),winningIndex:r.winning_slot_id?slots.findIndex(s=>s.id===r.winning_slot_id):null,confirmedBy:r.confirmed_by,confirmedAt:iso(r.confirmed_at),responses:related('poll_responses','poll_id',r.id).map(p=>({userId:p.participant_id,submittedAt:iso(p.submitted_at),choices:related('poll_choices','poll_id',r.id).filter(c=>c.participant_id===p.participant_id).sort((a,b)=>a.rank-b.rank).map(c=>slots.findIndex(s=>s.id===c.slot_id))}))};});
  db.documents=list('documents').map(r=>{const file=list('file_objects').find(f=>f.id===r.file_id);return {...base(r),cohortId:r.cohort_id,participantId:r.participant_id,sessionId:r.session_id,uploadedBy:r.uploaded_by,fileId:r.file_id,title:r.title,scope:r.scope,phase:r.phase,originalName:file.original_name,mime:file.mime_type,size:num(file.size_bytes),archived:!!r.archived_at,archivedAt:iso(r.archived_at)};});
  db.reports=list('reports').map(r=>({...base(r),cohortId:r.cohort_id,participantId:r.participant_id,authorId:r.author_id,type:['reflection','coach-evaluation'].includes(r.kind)?'individual':r.kind,title:r.title,highlights:r.highlights,progress:r.progress,nextSteps:r.next_steps,shareBuyer:r.share_buyer,status:r.status,updatedAt:iso(r.updated_at),publishedAt:iso(r.published_at)}));
  db.surveys=list('surveys').map(r=>{const questions=related('survey_questions','survey_id',r.id).sort((a,b)=>a.position-b.position);return {...base(r),cohortId:r.cohort_id,title:r.title,stage:r.stage,status:r.status,deadline:iso(r.deadline),questions:questions.map(q=>q.prompt),questionIds:questions.map(q=>q.id),responses:related('survey_responses','survey_id',r.id).map(p=>({userId:p.participant_id,reflection:p.reflection,submittedAt:iso(p.submitted_at),answers:questions.map(q=>list('survey_answers').find(a=>a.survey_id===r.id&&a.participant_id===p.participant_id&&a.question_id===q.id)?.rating)}))};});
  db.invoices=list('invoices').map(r=>({...base(r),cohortId:r.cohort_id,buyerId:r.buyer_id,number:r.number,title:r.title,amount:num(r.total_minor),currency:r.currency,dueDate:iso(r.due_on),status:r.status,issuedAt:iso(r.issued_at),payments:related('payments','invoice_id',r.id).filter(p=>p.status==='settled').map(p=>({...base(p),amount:num(p.amount_minor)*(p.kind==='refund'?-1:1),date:iso(p.received_at),method:p.method,reference:p.reference}))}));
  db.contracts=list('contracts').map(r=>{const ack=related('contract_acknowledgements','contract_id',r.id)[0];return {...base(r),cohortId:r.cohort_id,buyerId:r.buyer_id,title:r.title,terms:r.terms,amount:num(r.amount_minor),currency:r.currency,programName:r.program_name,company:r.company_name,startDate:iso(r.starts_on),endDate:iso(r.ends_on),status:r.status,contentHash:r.content_hash,requestedAt:iso(r.requested_at),...(ack?{acknowledgement:{id:ack.id,userId:ack.user_id,name:ack.name,contentHash:ack.content_hash,method:ack.method,at:iso(ack.acknowledged_at)}}:{})};});
  db.notifications=list('notifications').map(r=>({...base(r),userId:r.user_id,title:r.title,body:r.body,target:r.target,read:!!r.read_at,readAt:iso(r.read_at)}));
  db.messages=list('messages').map(r=>({...base(r),senderId:r.sender_id,recipientId:r.recipient_id,body:r.body,readAt:iso(r.read_at)}));
  db.outbox=list('email_deliveries').map(r=>({...base(r),recipient:r.recipient,subject:r.subject,body:r.body,key:r.deduplication_key,status:r.status}));
  db.hooks=list('outbox_events').filter(r=>r.aggregate_type==='platform-hook').map(r=>({...base(r),kind:r.kind,payload:r.payload,status:r.integration_status}));
  db.audit=list('audit_events').map(r=>({id:r.id,userId:r.actor_id,action:r.action,recordId:r.entity_id,at:iso(r.occurred_at)}));
  db.reminders=list('reminder_receipts').map(r=>({key:r.key,at:iso(r.created_at)}));
  const requests=list('idempotency_requests').filter(r=>Date.parse(r.expires_at)>Date.now());
  db.requests=requests.filter(r=>r.scope.startsWith('action:')).map(r=>({key:r.request_key,userId:r.scope.slice(7),fingerprint:r.request_hash,result:r.response_body,createdAt:iso(r.created_at),expiresAt:iso(r.expires_at)}));
  db.bookingRequests=requests.filter(r=>r.scope==='public:booking').map(r=>({key:r.request_key,fingerprint:r.request_hash,result:r.response_body,createdAt:iso(r.created_at),expiresAt:iso(r.expires_at)}));
  return db;
}
