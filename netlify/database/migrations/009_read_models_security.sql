-- These views are backend query helpers, not a replacement for API authorization.
-- security_invoker keeps underlying tenant RLS in effect (PostgreSQL 15+).
CREATE VIEW gocoach.visible_reports WITH (security_invoker=true) AS
SELECT r.*, CASE WHEN r.kind IN ('reflection','coach-evaluation') THEN 'individual' ELSE r.kind END AS frontend_type,
  author.name AS author_name, c.name AS cohort_name, participant.name AS participant_name
FROM gocoach.reports r
JOIN gocoach.cohorts c ON (c.workspace_id,c.id)=(r.workspace_id,r.cohort_id)
JOIN gocoach.users author ON (author.workspace_id,author.id)=(r.workspace_id,r.author_id)
LEFT JOIN gocoach.users participant ON (participant.workspace_id,participant.id)=(r.workspace_id,r.participant_id)
JOIN gocoach.users actor ON actor.workspace_id=r.workspace_id AND actor.id=gocoach.actor_id() AND actor.active
WHERE actor.role='coach'
  OR (actor.role='buyer' AND actor.buyer_id=c.buyer_id AND r.status='published' AND r.share_buyer)
  OR (actor.role='participant' AND EXISTS (
    SELECT 1 FROM gocoach.enrollments e WHERE e.workspace_id=r.workspace_id AND e.cohort_id=r.cohort_id
      AND e.participant_id=actor.id AND e.status IN ('enrolled','completed'))
    AND (r.author_id=actor.id OR (r.status='published' AND (r.participant_id IS NULL OR r.participant_id=actor.id))));

CREATE VIEW gocoach.buyer_participant_evaluations WITH (security_invoker=true) AS
SELECT e.workspace_id, c.buyer_id, e.cohort_id, c.name AS cohort_name,
  e.participant_id, participant.name AS participant_name, e.status AS enrollment_status,
  r.id AS report_id, r.title, r.highlights AS strengths, r.progress, r.next_steps,
  r.published_at, r.author_id AS coach_id, r.author_name AS coach_name,
  CASE WHEN r.id IS NULL THEN 'awaiting-evaluation' ELSE 'published' END AS evaluation_status
FROM gocoach.enrollments e
JOIN gocoach.cohorts c ON (c.workspace_id,c.id)=(e.workspace_id,e.cohort_id)
JOIN gocoach.users participant ON (participant.workspace_id,participant.id)=(e.workspace_id,e.participant_id)
JOIN gocoach.users actor ON actor.workspace_id=e.workspace_id AND actor.id=gocoach.actor_id() AND actor.active
LEFT JOIN LATERAL (
  SELECT v.* FROM gocoach.visible_reports v WHERE v.workspace_id=e.workspace_id AND v.cohort_id=e.cohort_id
    AND v.participant_id=e.participant_id AND v.kind='coach-evaluation' AND v.status='published' AND v.share_buyer
  ORDER BY v.published_at DESC, v.updated_at DESC, v.id DESC LIMIT 1
) r ON true
WHERE actor.role='coach' OR (actor.role='buyer' AND actor.buyer_id=c.buyer_id);

CREATE VIEW gocoach.visible_documents WITH (security_invoker=true) AS
SELECT d.*, f.original_name, f.mime_type, f.size_bytes, f.scan_status,
  CASE d.scope WHEN 'cohort' THEN 'Cohort members' WHEN 'individual' THEN 'Participant and coach'
    WHEN 'buyer' THEN 'Buyer and coach' ELSE 'Coach only' END AS access_label
FROM gocoach.documents d
JOIN gocoach.file_objects f ON (f.workspace_id,f.id)=(d.workspace_id,d.file_id)
JOIN gocoach.cohorts c ON (c.workspace_id,c.id)=(d.workspace_id,d.cohort_id)
JOIN gocoach.users actor ON actor.workspace_id=d.workspace_id AND actor.id=gocoach.actor_id() AND actor.active
WHERE d.archived_at IS NULL AND (actor.role='coach' OR (f.scan_status='clean' AND (
  (actor.role='buyer' AND actor.buyer_id=c.buyer_id AND d.scope IN ('cohort','buyer'))
  OR (actor.role='participant' AND (d.scope='cohort' OR (d.scope='individual' AND d.participant_id=actor.id))
    AND EXISTS (SELECT 1 FROM gocoach.enrollments e WHERE e.workspace_id=d.workspace_id AND e.cohort_id=d.cohort_id
      AND e.participant_id=actor.id AND e.status IN ('enrolled','completed'))))));

CREATE VIEW gocoach.invoice_balances WITH (security_invoker=true) AS
SELECT i.*, paid.net_paid_minor, i.total_minor-paid.net_paid_minor AS balance_minor,
  CASE WHEN i.status IN ('draft','void') THEN i.status WHEN paid.net_paid_minor=i.total_minor THEN 'paid'
    WHEN i.due_on<(now() AT TIME ZONE w.time_zone)::date THEN 'overdue'
    WHEN paid.net_paid_minor>0 THEN 'partially-paid' ELSE 'issued' END AS display_status
FROM gocoach.invoices i
JOIN gocoach.workspaces w ON w.id=i.workspace_id
JOIN gocoach.users actor ON actor.workspace_id=i.workspace_id AND actor.id=gocoach.actor_id() AND actor.active
CROSS JOIN LATERAL (SELECT coalesce(sum(CASE p.kind WHEN 'refund' THEN -p.amount_minor ELSE p.amount_minor END),0)::bigint AS net_paid_minor
  FROM gocoach.payments p WHERE p.workspace_id=i.workspace_id AND p.invoice_id=i.id AND p.status='settled') paid
WHERE actor.role='coach' OR (actor.role='buyer' AND actor.buyer_id=i.buyer_id AND i.status<>'draft');

-- Cash-basis revenue; filter fiscal/year dates using the workspace time zone.
-- Group by currency. Invoice volume is a separate measure from cash received.
CREATE VIEW gocoach.revenue_monthly WITH (security_invoker=true) AS
SELECT p.workspace_id, i.buyer_id, i.cohort_id, p.currency,
  date_trunc('month',p.received_at AT TIME ZONE w.time_zone)::date AS month,
  sum(CASE p.kind WHEN 'payment' THEN p.amount_minor ELSE 0 END) AS receipts_minor,
  sum(CASE p.kind WHEN 'refund' THEN p.amount_minor ELSE 0 END) AS refunds_minor,
  sum(CASE p.kind WHEN 'refund' THEN -p.amount_minor ELSE p.amount_minor END) AS net_revenue_minor
FROM gocoach.payments p
JOIN gocoach.invoices i ON (i.workspace_id,i.id)=(p.workspace_id,p.invoice_id)
JOIN gocoach.workspaces w ON w.id=p.workspace_id
JOIN gocoach.users actor ON actor.workspace_id=p.workspace_id AND actor.id=gocoach.actor_id() AND actor.active AND actor.role='coach'
WHERE p.status='settled'
GROUP BY p.workspace_id,i.buyer_id,i.cohort_id,p.currency,date_trunc('month',p.received_at AT TIME ZONE w.time_zone)::date;

CREATE VIEW gocoach.poll_response_matrix WITH (security_invoker=true) AS
SELECT s.workspace_id, s.poll_id, s.id AS slot_id, s.position, s.starts_at,
  count(c.participant_id) AS preference_count, coalesce(sum(6-c.rank),0) AS weighted_score,
  coalesce(jsonb_agg(jsonb_build_object('participantId',c.participant_id,'rank',c.rank)
    ORDER BY c.participant_id) FILTER (WHERE c.participant_id IS NOT NULL),'[]'::jsonb) AS responses
FROM gocoach.poll_slots s
JOIN gocoach.users actor ON actor.workspace_id=s.workspace_id AND actor.id=gocoach.actor_id() AND actor.active AND actor.role='coach'
LEFT JOIN gocoach.poll_choices c ON (c.workspace_id,c.poll_id,c.slot_id)=(s.workspace_id,s.poll_id,s.id)
GROUP BY s.workspace_id,s.poll_id,s.id,s.position,s.starts_at;

CREATE VIEW gocoach.survey_aggregates WITH (security_invoker=true) AS
SELECT s.workspace_id, s.id AS survey_id, s.cohort_id, s.stage, q.id AS question_id, q.position, q.prompt,
  count(a.rating) AS response_count, round(avg(a.rating),2) AS average_rating
FROM gocoach.surveys s
JOIN gocoach.cohorts c ON (c.workspace_id,c.id)=(s.workspace_id,s.cohort_id)
JOIN gocoach.users actor ON actor.workspace_id=s.workspace_id AND actor.id=gocoach.actor_id() AND actor.active
JOIN gocoach.survey_questions q ON (q.workspace_id,q.survey_id)=(s.workspace_id,s.id)
LEFT JOIN gocoach.survey_answers a ON (a.workspace_id,a.survey_id,a.question_id)=(q.workspace_id,q.survey_id,q.id)
WHERE actor.role='coach' OR (actor.role='buyer' AND actor.buyer_id=c.buyer_id AND s.status<>'draft')
GROUP BY s.workspace_id,s.id,s.cohort_id,s.stage,q.id,q.position,q.prompt;

-- IDs are stable, including compound child keys. Remove/recreate draft child
-- rows when changing their position; never move records across tenants.
CREATE FUNCTION gocoach.freeze_primary_key() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE field text;
BEGIN
  FOREACH field IN ARRAY TG_ARGV LOOP
    IF (to_jsonb(NEW)->field) IS DISTINCT FROM (to_jsonb(OLD)->field) THEN
      RAISE EXCEPTION 'Primary keys are immutable: %',field USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $fn$;
DO $security$
DECLARE relation record; key_args text;
BEGIN
  FOR relation IN SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='gocoach' LOOP
    EXECUTE format('ALTER TABLE gocoach.%I ENABLE ROW LEVEL SECURITY',relation.tablename);
    EXECUTE format('CREATE POLICY workspace_isolation ON gocoach.%I USING (%I=gocoach.workspace_id()) WITH CHECK (%I=gocoach.workspace_id())',
      relation.tablename, CASE WHEN relation.tablename='workspaces' THEN 'id' ELSE 'workspace_id' END,
      CASE WHEN relation.tablename='workspaces' THEN 'id' ELSE 'workspace_id' END);
    SELECT string_agg(quote_literal(a.attname),',' ORDER BY keys.ordinality) INTO key_args
    FROM pg_catalog.pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY keys(attnum,ordinality)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=keys.attnum
    WHERE i.indrelid=format('gocoach.%I',relation.tablename)::regclass AND i.indisprimary;
    EXECUTE format('CREATE TRIGGER a_freeze_primary_key BEFORE UPDATE ON gocoach.%I FOR EACH ROW EXECUTE FUNCTION gocoach.freeze_primary_key(%s)',relation.tablename,key_args);
  END LOOP;
END $security$;
REVOKE ALL ON ALL TABLES IN SCHEMA gocoach FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gocoach FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA gocoach REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA gocoach REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
