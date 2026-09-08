import { createHash } from 'node:crypto';
import { day } from './codec.mjs';
/** Stable UUIDs for ordered children and the explicitly fictional demo seed.
 * @param {string} value @returns {string} */
export function stableId(value) {
  const h=createHash('sha256').update(value).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
const nullable=value=>value||null;
const slotId=(poll,index)=>poll.slotIds?.[index]||stableId(`poll:${poll.id}:${index}`);
const questionId=(survey,index)=>survey.questionIds?.[index]||stableId(`survey:${survey.id}:${index}`);
/** @param {any} db @param {string} now @returns {Record<string,object[]>} */
export function encode(db, now) {
  const rows={}, add=(table,row)=>{(rows[table]||=[]).push(Object.fromEntries(Object.entries(row).filter(([,v])=>v!==undefined)));};
  const base=r=>({id:r.id,created_at:r.createdAt});
  const coach=db.primaryCoachId||db.users.find(u=>u.role==='coach'&&u.active!==false)?.id;
  for(const r of db.buyers){add('buyers',{...base(r),company:r.company,contact_name:r.contact,contact_email:r.email,billing_email:r.billingEmail,billing_address:r.billingAddress||''});if(coach)add('buyer_private_notes',{buyer_id:r.id,coach_id:coach,body:r.notes||''});}
  for(const r of db.users){add('users',{...base(r),name:r.name,email:r.email,role:r.role,buyer_id:nullable(r.buyerId),active:r.active!==false});if(r.passwordHash)add('user_credentials',{user_id:r.id,password_hash:r.passwordHash,algorithm:'scrypt'});}
  for(const r of db.authSessions)add('auth_sessions',{...base(r),user_id:r.userId,token_hash:r.hash,expires_at:new Date(r.expiresAt).toISOString()});
  for(const r of db.cohorts){add('cohorts',{...base(r),buyer_id:r.buyerId,name:r.name,description:r.description||'',starts_on:day(r.startDate),ends_on:day(r.endDate),time_zone:r.timeZone,capacity:r.capacity,price_minor:r.price,currency:r.currency||'USD',status:r.status});if(coach)add('cohort_coaches',{cohort_id:r.id,coach_id:coach,is_lead:true});}
  for(const r of db.enrollments)add('enrollments',{...base(r),cohort_id:r.cohortId,participant_id:r.userId,status:r.status});
  for(const r of db.invitations)add('invitations',{...base(r),user_id:r.userId,cohort_id:nullable(r.cohortId),token_hash:r.hash,expires_at:new Date(r.expiresAt).toISOString(),accepted_at:nullable(r.acceptedAt)});
  for(const r of db.leads)add('leads',{...base(r),name:r.name,email:r.email,company:r.company||'',stage:r.stage,value_minor:r.value||0,note:r.note||'',inquiry_reference:nullable(r.inquiryReference)});
  for(const r of db.sessions){add('sessions',{...base(r),cohort_id:nullable(r.cohortId),participant_id:nullable(r.participantId),coach_id:r.coachId||coach,lead_id:db.leads.find(l=>l.sessionId===r.id)?.id||null,title:r.title,kind:r.kind,status:r.status,starts_at:r.startsAt,duration_minutes:r.duration,time_zone:r.timeZone||db.cohorts.find(c=>c.id===r.cohortId)?.timeZone||db.settings.timeZone,meeting_url:nullable(r.meetingUrl),materials:r.materials||'',summary:r.summary||'',cancellation_hash:nullable(r.cancellationHash)});
    const sessionRow=rows.sessions.at(-1);sessionRow.provider=r.provider||'local';sessionRow.reschedule_url=nullable(r.rescheduleUrl);sessionRow.cancel_url=nullable(r.cancelUrl);
    if(r.contact)add('session_contacts',{session_id:r.id,name:r.contact.name,email:r.contact.email,consent_at:r.createdAt||now});
    if(coach)add('session_private_notes',{session_id:r.id,coach_id:r.coachId||coach,body:r.privateNotes||''});}
  for(const r of db.subscribers)add('subscribers',{id:r.id,email:r.email,status:r.status,consent_at:r.consentAt,unsubscribed_at:r.status==='unsubscribed'?(r.unsubscribedAt||now):null,unsubscribe_hash:r.tokenHash});
  for(const p of db.polls){add('availability_polls',{...base(p),cohort_id:p.cohortId,title:p.title,deadline:p.deadline,status:p.status,winning_slot_id:p.status==='confirmed'?slotId(p,p.winningIndex):null,confirmed_by:p.status==='confirmed'?(p.confirmedBy||coach):null,confirmed_at:p.status==='confirmed'?(p.confirmedAt||now):null});
    p.slots.forEach((s,i)=>add('poll_slots',{id:slotId(p,i),poll_id:p.id,position:i,starts_at:s}));
    for(const r of p.responses){add('poll_responses',{poll_id:p.id,cohort_id:p.cohortId,participant_id:r.userId,submitted_at:r.submittedAt});r.choices.forEach((c,i)=>add('poll_choices',{poll_id:p.id,participant_id:r.userId,slot_id:slotId(p,c),rank:i+1}));}}
  for(const r of db.documents){const fileId=r.fileId||r.id;add('file_objects',{id:fileId,storage_backend:'postgres',bucket:'',object_key:fileId,original_name:r.originalName,mime_type:r.mime,size_bytes:r.size,scan_status:'clean',created_at:r.createdAt});
    add('documents',{...base(r),cohort_id:r.cohortId,participant_id:nullable(r.participantId),session_id:nullable(r.sessionId),file_id:fileId,uploaded_by:r.uploadedBy||coach,title:r.title,scope:r.scope,phase:r.phase,archived_at:r.archived?(r.archivedAt||now):null});}
  for(const r of db.reports)add('reports',{...base(r),cohort_id:r.cohortId,participant_id:nullable(r.participantId),author_id:r.authorId,kind:r.type==='individual'?(db.users.find(u=>u.id===r.authorId)?.role==='coach'?'coach-evaluation':'reflection'):r.type,title:r.title,highlights:r.highlights,progress:r.progress||'',next_steps:r.nextSteps||'',share_buyer:r.shareBuyer===true,status:r.status,published_at:nullable(r.publishedAt)});
  for(const s of db.surveys){add('surveys',{...base(s),cohort_id:s.cohortId,title:s.title,stage:s.stage,status:s.status,deadline:s.deadline});s.questions.forEach((prompt,i)=>add('survey_questions',{id:questionId(s,i),survey_id:s.id,position:i,prompt}));
    for(const r of s.responses){add('survey_responses',{survey_id:s.id,cohort_id:s.cohortId,participant_id:r.userId,reflection:r.reflection||'',submitted_at:r.submittedAt});r.answers.forEach((rating,i)=>add('survey_answers',{survey_id:s.id,participant_id:r.userId,question_id:questionId(s,i),rating}));}}
  for(const r of db.invoices){add('invoices',{...base(r),cohort_id:r.cohortId,buyer_id:r.buyerId,number:r.number,title:r.title,currency:r.currency||'USD',subtotal_minor:r.amount,total_minor:r.amount,status:r.status,due_on:day(r.dueDate),issued_at:r.status==='draft'?null:(r.issuedAt||r.createdAt||now)});
    add('invoice_lines',{invoice_id:r.id,position:1,description:r.title,quantity:1,unit_price_minor:r.amount});
    for(const p of r.payments)add('payments',{...base(p),invoice_id:r.id,kind:p.amount<0?'refund':'payment',amount_minor:Math.abs(p.amount),currency:r.currency||'USD',status:'settled',method:p.method,reference:p.reference,received_at:p.date});}
  for(const r of db.contracts){add('contracts',{...base(r),cohort_id:r.cohortId,buyer_id:r.buyerId,title:r.title,terms:r.terms,amount_minor:r.amount,currency:r.currency||'USD',program_name:r.programName,company_name:r.company,starts_on:day(r.startDate),ends_on:day(r.endDate),status:r.status,content_hash:nullable(r.contentHash),requested_at:nullable(r.requestedAt)});
    const a=r.acknowledgement;if(a)add('contract_acknowledgements',{id:a.id||stableId(`ack:${r.id}:${a.userId}`),contract_id:r.id,user_id:a.userId,name:a.name,content_hash:a.contentHash,method:a.method,consent_text:'I confirm that I have reviewed this agreement.',acknowledged_at:a.at});}
  for(const r of db.notifications)add('notifications',{...base(r),user_id:r.userId,title:r.title,body:r.body,target:r.target,read_at:r.read?(r.readAt||now):null});
  for(const r of db.messages)add('messages',{...base(r),sender_id:r.senderId,recipient_id:r.recipientId,body:r.body,read_at:nullable(r.readAt)});
  for(const r of db.outbox)add('email_deliveries',{...base(r),recipient:r.recipient,subject:r.subject,body:r.body,deduplication_key:r.key||r.id,status:r.status});
  for(const r of db.hooks)add('outbox_events',{...base(r),kind:r.kind,aggregate_type:'platform-hook',deduplication_key:r.id,payload:r.payload,status:'pending',integration_status:r.status});
  for(const r of db.audit)add('audit_events',{id:r.id,actor_id:r.userId||null,action:r.action,entity_type:'platform',entity_id:r.recordId||null,occurred_at:r.at});
  for(const r of db.reminders)add('reminder_receipts',{key:r.key,created_at:r.at});
  for(const [items,scope] of [[db.requests||[],null],[db.bookingRequests||[],'public:booking']])for(const r of items)add('idempotency_requests',{scope:scope||`action:${r.userId}`,request_key:r.key,request_hash:r.fingerprint,response_status:200,response_body:r.result,created_at:r.createdAt||now,expires_at:r.expiresAt||new Date(Date.parse(now)+30*86400000).toISOString()});
  return rows;
}
