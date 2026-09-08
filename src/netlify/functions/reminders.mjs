import {createDatabaseStore} from '../../server/postgres/runtime.mjs';
import {runReminders} from '../../server/platform/operations.mjs';
/** Netlify invokes scheduled functions internally; there is no public HTTP route.
 * @returns {Promise<void>} */
export default async function reminders(){
  const store=await createDatabaseStore();
  const result=await store.run(db=>runReminders(db),true);
  await store.transaction(async client=>{
    for(const table of ['rate_limit_buckets','booking_contexts','idempotency_requests'])await client.query(`DELETE FROM gocoach.${table} WHERE workspace_id=$1 AND expires_at<now()`,[store.workspaceId]);
  });
  console.log('GoCoach reminders prepared:',result.created);
  return Response.json({created:result.created});
}
export const config={schedule:'*/5 * * * *'};
