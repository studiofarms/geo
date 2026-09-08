import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { psql, migrationScript } from '../../scripts/database.mjs';

if (process.env.GOCOACH_DB_TEST !== 'isolated-cluster') throw new Error('Run npm --prefix config run db:test; these tests require an isolated cluster.');
const execute = sql => psql(sql, { args: ['--tuples-only','--no-align','--quiet'] });
const transaction = sql => execute(`BEGIN; SET search_path=gocoach,test_support,public; ${sql}\n SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`);
const asActor = (actor, sql, workspace = 1) => transaction(`SET LOCAL ROLE gocoach_test_runtime;
  SELECT set_config('gocoach.workspace_id',tid(${workspace})::text,true);
  SELECT set_config('gocoach.user_id',tid(${actor})::text,true); ${sql}`);
before(async () => { await execute(await readFile(new URL('./fixture.sql', import.meta.url), 'utf8')); });

test('all application tables have tenant RLS, primary keys, and no public privileges', async () => {
  await transaction(`SELECT assert(NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='gocoach' AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary))), 'Missing table protections');
    SELECT assert(NOT EXISTS(SELECT 1 FROM pg_namespace n, LATERAL aclexplode(n.nspacl) a
      WHERE n.nspname='gocoach' AND a.grantee=0 AND a.privilege_type='USAGE'), 'Public schema access');`);
});
test('runtime reads fail closed without a tenant and reject cross-tenant writes', async () => {
  await transaction(`SET LOCAL ROLE gocoach_test_runtime; SELECT assert((SELECT count(*) FROM users)=0,'Tenant claim required');`);
  await asActor(20, `SELECT assert((SELECT count(*) FROM workspaces)=1,'One workspace only');
    SELECT assert(NOT EXISTS(SELECT 1 FROM users WHERE workspace_id=tid(2)),'Tenant leak');`);
  await assert.rejects(asActor(20, `INSERT INTO users(workspace_id,name,email,role) VALUES(tid(2),'Leak','leak@example.test','coach');`), /row-level security/);
});
test('foreign keys prevent cross-tenant associations and roles cannot drift', async () => {
  await assert.rejects(transaction(`INSERT INTO cohorts(workspace_id,buyer_id,name,starts_on,ends_on,time_zone,capacity,price_minor)
    VALUES(tid(1),tid(12),'Wrong tenant','2030-01-01','2030-02-01','UTC',7,10000);`), /foreign key constraint/);
  await assert.rejects(transaction(`UPDATE users SET role='coach' WHERE workspace_id=tid(1) AND id=tid(22);`), /cannot be reassigned/);
  await assert.rejects(transaction(`INSERT INTO enrollments(workspace_id,cohort_id,participant_id) VALUES(tid(1),tid(30),tid(21));`), /participant account/);
  await assert.rejects(transaction(`UPDATE buyers SET workspace_id=tid(2) WHERE workspace_id=tid(1) AND id=tid(10);`), /Primary keys are immutable/);
});
test('buyer evaluations select the latest shared coach report and preserve pending roster entries', async () => {
  await asActor(21, `SELECT assert((SELECT count(*) FROM buyer_participant_evaluations)=3,'Expected all buyer roster entries');
    SELECT assert((SELECT report_id FROM buyer_participant_evaluations WHERE cohort_id=tid(30) AND participant_id=tid(22))=tid(50),'Wrong coach report');
    SELECT assert((SELECT evaluation_status FROM buyer_participant_evaluations WHERE cohort_id=tid(30) AND participant_id=tid(23))='awaiting-evaluation','Missing pending state');
    SELECT assert(NOT EXISTS(SELECT 1 FROM visible_reports WHERE id IN (tid(51),tid(52),tid(54))),'Private report leak');`);
  await asActor(24, `SELECT assert((SELECT count(*) FROM buyer_participant_evaluations)=1,'Other buyer roster leak');
    SELECT assert((SELECT report_id FROM buyer_participant_evaluations)=tid(54),'Other buyer evaluation missing');`);
  await asActor(22, `SELECT assert((SELECT count(*) FROM buyer_participant_evaluations)=0,'Participant cannot use buyer view');`);
});
test('participant reports and document access follow ownership and scope', async () => {
  await asActor(23, `SELECT assert(NOT EXISTS(SELECT 1 FROM visible_reports WHERE participant_id=tid(22)),'Other participant report leak');
    SELECT assert((SELECT count(*) FROM visible_documents)=2,'Participant document scopes');`);
  await asActor(21, `SELECT assert((SELECT count(*) FROM visible_documents)=2,'Buyer document scopes');`);
  await asActor(20, `SELECT assert((SELECT count(*) FROM visible_documents)=5,'Coach documents');`);
  await transaction(`UPDATE file_objects SET scan_status='blocked'; SET LOCAL ROLE gocoach_test_runtime;
    SELECT set_config('gocoach.workspace_id',tid(1)::text,true); SELECT set_config('gocoach.user_id',tid(21)::text,true);
    SELECT assert((SELECT count(*) FROM visible_documents)=0,'Blocked files must not be shared');`);
});
test('report author rules and immutable revision history', async () => {
  await assert.rejects(transaction(`INSERT INTO reports(workspace_id,cohort_id,participant_id,author_id,kind,title,highlights)
    VALUES(tid(1),tid(30),tid(23),tid(22),'coach-evaluation','Invalid','Invalid');`), /kind does not match/);
  await transaction(`UPDATE reports SET progress='Updated progress' WHERE workspace_id=tid(1) AND id=tid(50);
    SELECT assert((SELECT count(*) FROM report_versions WHERE report_id=tid(50))=2,'Revision not recorded');`);
  await assert.rejects(transaction(`UPDATE report_versions SET content='{}' WHERE report_id=tid(50);`), /append-only/);
});
test('session lengths and conflicting bookings are enforced, adjacent bookings allowed', async () => {
  await assert.rejects(transaction(`INSERT INTO sessions(workspace_id,coach_id,title,kind,status,starts_at,duration_minutes,time_zone)
    VALUES(tid(1),tid(20),'Overlap','discovery','scheduled','2030-01-08T17:00Z',30,'UTC');`), /already has a session/);
  await transaction(`INSERT INTO sessions(workspace_id,coach_id,title,kind,status,starts_at,duration_minutes,time_zone)
    VALUES(tid(1),tid(20),'Adjacent','discovery','scheduled','2030-01-08T17:30Z',30,'UTC');
    SELECT assert(EXISTS(SELECT 1 FROM sessions WHERE title='Adjacent' AND ends_at='2030-01-08T18:00Z'),'Computed end time');`);
  await assert.rejects(transaction(`UPDATE cohorts SET time_zone='Made/Up' WHERE id=tid(30);`), /recognized IANA/);
});
test('polls require exactly five ranked choices and a winner from the same poll', async () => {
  await assert.rejects(transaction(`DELETE FROM poll_choices WHERE poll_id=tid(80) AND rank=5;`), /exactly five/);
  await assert.rejects(transaction(`UPDATE availability_polls SET status='confirmed',winning_slot_id=tid(141),confirmed_by=tid(20),confirmed_at=now() WHERE id=tid(80);`), /foreign key constraint/);
  await transaction(`UPDATE availability_polls SET status='confirmed',winning_slot_id=tid(81),confirmed_by=tid(20),confirmed_at=now() WHERE id=tid(80);`);
  await asActor(20, `SELECT assert((SELECT sum(weighted_score) FROM poll_response_matrix)=15,'Preference scoring');`);
});
test('survey responses require all answers and freeze questions after responses', async () => {
  await assert.rejects(transaction(`INSERT INTO survey_responses(workspace_id,survey_id,cohort_id,participant_id)
    VALUES(tid(1),tid(100),tid(30),tid(23));`), /Answer every survey/);
  await assert.rejects(transaction(`UPDATE survey_questions SET prompt='Changed' WHERE id=tid(101);`), /immutable after a response/);
  await asActor(21, `SELECT assert((SELECT sum(response_count) FROM survey_aggregates)=2,'Aggregated survey response count');
    SELECT assert((SELECT average_rating FROM survey_aggregates WHERE question_id=tid(101))=4,'Survey average');`);
});
test('issued invoice totals, line immutability, payments, refunds and currencies', async () => {
  await assert.rejects(transaction(`INSERT INTO invoices(workspace_id,cohort_id,buyer_id,number,title,subtotal_minor,total_minor,due_on,status)
    VALUES(tid(1),tid(30),tid(10),'BAD','No lines',10000,10000,'2030-02-01','issued');`), /subtotal must equal/);
  await assert.rejects(transaction(`UPDATE invoice_lines SET unit_price_minor=9000 WHERE invoice_id=tid(60);`), /Issued invoice lines are immutable/);
  await assert.rejects(transaction(`INSERT INTO payments(workspace_id,invoice_id,currency,amount_minor,method,reference,received_at)
    VALUES(tid(1),tid(60),'EUR',1000,'manual','wrong-currency',now());`), /foreign key constraint/);
  await transaction(`INSERT INTO payments(workspace_id,id,invoice_id,currency,amount_minor,method,reference,received_at)
    VALUES(tid(1),tid(62),tid(60),'USD',10000,'manual','full',now());
    SELECT set_config('gocoach.user_id',tid(21)::text,true);
    SELECT assert((SELECT display_status FROM invoice_balances WHERE id=tid(60))='paid','Paid status');
    INSERT INTO payments(workspace_id,invoice_id,kind,currency,amount_minor,method,reference,received_at)
    VALUES(tid(1),tid(60),'refund','USD',1000,'manual','refund',now());
    SELECT assert((SELECT balance_minor FROM invoice_balances WHERE id=tid(60))=1000,'Refund balance');`);
  await assert.rejects(transaction(`INSERT INTO payments(workspace_id,id,invoice_id,currency,amount_minor,method,reference,received_at)
    VALUES(tid(1),tid(62),tid(60),'USD',1000,'manual','immutable',now()); DELETE FROM payments WHERE id=tid(62);`), /Settled payments are immutable/);
});
test('contracts preserve sent content and restrict acknowledgement to the owning buyer', async () => {
  await assert.rejects(transaction(`UPDATE contracts SET terms='Changed' WHERE id=tid(120);`), /cannot be rewritten/);
  await assert.rejects(transaction(`INSERT INTO contract_acknowledgements(workspace_id,contract_id,user_id,name,content_hash,method,consent_text)
    VALUES(tid(1),tid(120),tid(24),'Wrong buyer',repeat('a',64),'local-prototype','I agree');`), /Only the owning buyer/);
  await transaction(`INSERT INTO contract_acknowledgements(workspace_id,contract_id,user_id,name,content_hash,method,consent_text)
    VALUES(tid(1),tid(120),tid(21),'Buyer A',repeat('a',64),'local-prototype','I agree');`);
});
test('outbox and request keys prevent duplicate work', async () => {
  await assert.rejects(transaction(`INSERT INTO outbox_events(workspace_id,kind,aggregate_type,deduplication_key,payload)
    VALUES(tid(1),'reminder','session','same','{}'),(tid(1),'reminder','session','same','{}');`), /duplicate key/);
  await transaction(`SELECT assert(next_invoice_number(tid(1),2031)='GC-2031-001','First invoice number');
    SELECT assert(next_invoice_number(tid(1),2031)='GC-2031-002','Second invoice number');`);
});

async function race(a, b, isolation = 'READ COMMITTED') {
  let signalReady; let signalFailure;
  const ready = new Promise((resolve, reject) => { signalReady = resolve; signalFailure = reject; });
  let output = '';
  const first = psql(`BEGIN ISOLATION LEVEL ${isolation}; SET search_path=gocoach,test_support,public; ${a}
    SELECT 'RACE_LOCK_HELD'; SELECT pg_sleep(0.3); COMMIT;`, {
    args: ['--tuples-only','--no-align','--quiet'],
    onOutput: chunk => { output += chunk; if (output.includes('RACE_LOCK_HELD')) signalReady(); },
  });
  first.catch(signalFailure);
  await ready;
  const second = execute(`BEGIN ISOLATION LEVEL ${isolation}; SET search_path=gocoach,test_support,public; ${b} COMMIT;`);
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, JSON.stringify(results.map(result => result.reason?.message || 'committed')));
}
test('competing session bookings cannot both commit', async () => {
  for (const [isolation, date] of [['READ COMMITTED','2030-02-01'],['REPEATABLE READ','2030-02-02']]) {
    const insert = `INSERT INTO sessions(workspace_id,coach_id,title,kind,status,starts_at,duration_minutes,time_zone)
      VALUES(tid(1),tid(26),'Race','discovery','scheduled','${date}T15:00Z',30,'UTC');`;
    await race(insert, insert, isolation);
  }
});
test('competing enrollments cannot overfill the final seat', async () => {
  const insert = participant => `INSERT INTO enrollments(workspace_id,cohort_id,participant_id) VALUES(tid(1),tid(32),tid(${participant}));`;
  await race(insert(22),insert(23));
});
test('competing payments cannot exceed the balance', async () => {
  const insert = reference => `INSERT INTO payments(workspace_id,invoice_id,currency,amount_minor,method,reference,received_at)
    VALUES(tid(1),tid(61),'USD',7000,'manual','${reference}',now());`;
  await race(insert('race-one'),insert('race-two'));
});
test('edited applied migrations are refused', async () => {
  await execute(`UPDATE gocoach_meta.schema_migrations SET checksum=repeat('0',64) WHERE version='001_identity_programs.sql';`);
  await assert.rejects(psql(await migrationScript()), /missing or has changed/);
});
