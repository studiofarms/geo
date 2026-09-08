import { encode } from './rows.mjs';
const keyColumns={user_credentials:['user_id'],cohort_coaches:['cohort_id','coach_id'],buyer_private_notes:['buyer_id','coach_id'],session_contacts:['session_id'],session_private_notes:['session_id','coach_id'],poll_responses:['poll_id','participant_id'],poll_choices:['poll_id','participant_id','rank'],survey_responses:['survey_id','participant_id'],survey_answers:['survey_id','participant_id','question_id'],invoice_lines:['invoice_id','position'],reminder_receipts:['key'],idempotency_requests:['scope','request_key']};
const removable=new Set(['auth_sessions','invitations','poll_choices','poll_responses','survey_questions','survey_answers','survey_responses','idempotency_requests']);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const quote=identifier=>{if(!/^[a-z_]+$/.test(identifier))throw new Error('Invalid SQL identifier');return `"${identifier}"`;};
/** @param {any} client @param {string} workspace @param {string} table @param {object[]} before @param {object[]} after @returns {Promise<void>} */
export async function syncRows(client,workspace,table,before=[],after=[]) {
  const keys=keyColumns[table]||['id'],key=row=>JSON.stringify(keys.map(k=>row[k]));
  const old=new Map(before.map(row=>[key(row),row])),next=new Set(after.map(key));
  if(removable.has(table))for(const row of before)if(!next.has(key(row)))await client.query(`DELETE FROM gocoach.${quote(table)} WHERE workspace_id=$1 AND ${keys.map((k,i)=>`${quote(k)}=$${i+2}`).join(' AND ')}`,[workspace,...keys.map(k=>row[k])]);
  for(const row of after){if(same(old.get(key(row)),row))continue;
    const columns=['workspace_id',...Object.keys(row)],values=[workspace,...Object.values(row)],updates=Object.keys(row).filter(k=>!keys.includes(k));
    const conflict=updates.length?`DO UPDATE SET ${updates.map(k=>`${quote(k)}=EXCLUDED.${quote(k)}`).join(',')}`:'DO NOTHING';
    await client.query(`INSERT INTO gocoach.${quote(table)} (${columns.map(quote).join(',')}) VALUES (${values.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT (workspace_id,${keys.map(quote).join(',')}) ${conflict}`,values);
  }
}
/** Persist only changed domain records, in FK order, inside the caller's transaction.
 * @param {any} client @param {string} workspace @param {any} before @param {any} after @returns {Promise<void>} */
export async function writeState(client,workspace,before,after) {
  const now=new Date().toISOString(),old=encode(before,now),next=encode(after,now);
  const sync=table=>syncRows(client,workspace,table,old[table],next[table]);
  const newAudit=after.audit.find(a=>!before.audit.some(b=>a.id===b.id));
  if(newAudit?.userId)await client.query("SELECT set_config('gocoach.user_id',$1,true)",[newAudit.userId]);
  for(const table of ['buyers','users','user_credentials','auth_sessions','buyer_private_notes','cohorts','cohort_coaches','enrollments','invitations','leads'])await sync(table);
  // Temporarily clear the old series within this transaction so shifting several
  // sessions cannot falsely collide with another old position in the same series.
  for(const row of next.sessions||[]){const prior=(old.sessions||[]).find(s=>s.id===row.id);
    if(prior?.status==='scheduled'&&(prior.starts_at!==row.starts_at||prior.duration_minutes!==row.duration_minutes||prior.coach_id!==row.coach_id))
      await client.query("UPDATE gocoach.sessions SET status='draft' WHERE workspace_id=$1 AND id=$2",[workspace,row.id]);}
  for(const table of ['sessions','session_contacts','session_private_notes','subscribers','availability_polls','poll_slots','poll_responses'])await sync(table);
  // Ranks have a secondary UNIQUE slot key, so replacing the set avoids transient
  // duplicate slots when a participant reorders the same five preferences.
  const choicesBefore=old.poll_choices||[],choicesAfter=next.poll_choices||[];
  if(!same(choicesBefore,choicesAfter)){
    const changed=new Set([...choicesBefore,...choicesAfter].map(r=>`${r.poll_id}/${r.participant_id}`));
    for(const compound of changed){const [poll,participant]=compound.split('/');
      const a=choicesBefore.filter(r=>r.poll_id===poll&&r.participant_id===participant),b=choicesAfter.filter(r=>r.poll_id===poll&&r.participant_id===participant);
      if(same(a,b))continue;
      await client.query('DELETE FROM gocoach.poll_choices WHERE workspace_id=$1 AND poll_id=$2 AND participant_id=$3',[workspace,poll,participant]);
      await syncRows(client,workspace,'poll_choices',[],b);
    }
  }
  for(const table of ['file_objects','documents'])await sync(table);
  for(const file of after.pendingFiles||[])await client.query('INSERT INTO gocoach.file_contents(workspace_id,file_id,contents) VALUES($1,$2,$3)',[workspace,file.id,Buffer.from(file.base64,'base64')]);
  for(const table of ['reports','surveys','survey_questions','survey_responses','survey_answers'])await sync(table);
  const newIssued=(next.invoices||[]).filter(r=>r.status!=='draft'&&!(old.invoices||[]).some(o=>o.id===r.id));
  await syncRows(client,workspace,'invoices',old.invoices,(next.invoices||[]).map(r=>newIssued.some(i=>i.id===r.id)?{...r,status:'draft',issued_at:null}:r));
  await sync('invoice_lines');
  for(const row of newIssued)await client.query('UPDATE gocoach.invoices SET status=$3,issued_at=$4 WHERE workspace_id=$1 AND id=$2',[workspace,row.id,row.status,row.issued_at]);
  for(const table of ['payments','contracts','contract_acknowledgements','notifications','messages','email_deliveries','outbox_events','audit_events','reminder_receipts','idempotency_requests'])await sync(table);
  if(!same(before.settings,after.settings)){
    await client.query('INSERT INTO gocoach.workspace_settings(workspace_id,settings) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET settings=EXCLUDED.settings,updated_at=now()',[workspace,after.settings]);
    await client.query('UPDATE gocoach.workspaces SET time_zone=$2 WHERE id=$1',[workspace,after.settings.timeZone]);
  }
}
