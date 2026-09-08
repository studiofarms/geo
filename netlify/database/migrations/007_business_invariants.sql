CREATE FUNCTION gocoach.actor_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('gocoach.user_id', true), '')::uuid $$;
CREATE FUNCTION gocoach.workspace_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('gocoach.workspace_id', true), '')::uuid $$;

CREATE FUNCTION gocoach.require_coach() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, gocoach AS $fn$
DECLARE coach uuid := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gocoach.users WHERE workspace_id=NEW.workspace_id AND id=coach AND role='coach') THEN
    RAISE EXCEPTION 'A coach account is required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
DO $install$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['cohort_coaches','availability_rules','availability_exceptions','session_private_notes','buyer_private_notes'] LOOP
    EXECUTE format('CREATE TRIGGER require_coach BEFORE INSERT OR UPDATE ON gocoach.%I FOR EACH ROW EXECUTE FUNCTION gocoach.require_coach(''coach_id'')', relation);
  END LOOP;
END $install$;

CREATE FUNCTION gocoach.freeze_user_scope() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.workspace_id,NEW.id,NEW.role,NEW.buyer_id) IS DISTINCT FROM (OLD.workspace_id,OLD.id,OLD.role,OLD.buyer_id) THEN
    RAISE EXCEPTION 'Account identity, role, and buyer cannot be reassigned; create a new account' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER freeze_scope BEFORE UPDATE ON gocoach.users FOR EACH ROW EXECUTE FUNCTION gocoach.freeze_user_scope();

-- Updating the parent row serializes competitors, including at REPEATABLE READ
-- where PostgreSQL aborts the conflicting writer. Retry SQLSTATE 40001/40P01.
CREATE FUNCTION gocoach.enrollment_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, gocoach AS $fn$
DECLARE capacity_limit integer;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.workspace_id,NEW.id,NEW.cohort_id,NEW.participant_id) IS DISTINCT FROM (OLD.workspace_id,OLD.id,OLD.cohort_id,OLD.participant_id) THEN
    RAISE EXCEPTION 'An enrollment cannot move to another participant or cohort' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gocoach.users WHERE workspace_id=NEW.workspace_id AND id=NEW.participant_id AND role='participant') THEN
    RAISE EXCEPTION 'Enrollment requires a participant account' USING ERRCODE='23514';
  END IF;
  UPDATE gocoach.cohorts SET enrollment_revision=enrollment_revision+1
    WHERE workspace_id=NEW.workspace_id AND id=NEW.cohort_id RETURNING capacity INTO capacity_limit;
  IF NEW.status<>'withdrawn' AND (SELECT count(*) FROM gocoach.enrollments WHERE workspace_id=NEW.workspace_id AND cohort_id=NEW.cohort_id AND status<>'withdrawn' AND id<>NEW.id)>=capacity_limit THEN
    RAISE EXCEPTION 'Cohort capacity exceeded' USING ERRCODE='23514';
  END IF;
  NEW.updated_at=now();
  RETURN NEW;
END $fn$;
CREATE TRIGGER enrollment_guard BEFORE INSERT OR UPDATE ON gocoach.enrollments FOR EACH ROW EXECUTE FUNCTION gocoach.enrollment_guard();
CREATE FUNCTION gocoach.cohort_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, gocoach AS $fn$
BEGIN
  IF NEW.buyer_id<>OLD.buyer_id OR NEW.workspace_id<>OLD.workspace_id THEN
    RAISE EXCEPTION 'Cohort ownership cannot be reassigned' USING ERRCODE='23514';
  END IF;
  IF NEW.capacity < (SELECT count(*) FROM gocoach.enrollments WHERE workspace_id=NEW.workspace_id AND cohort_id=NEW.id AND status<>'withdrawn') THEN
    RAISE EXCEPTION 'Capacity is below the existing roster' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER cohort_guard BEFORE UPDATE ON gocoach.cohorts FOR EACH ROW EXECUTE FUNCTION gocoach.cohort_guard();
CREATE FUNCTION gocoach.enrollment_history_record() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO gocoach.enrollment_history(workspace_id,enrollment_id,status,actor_id)
      VALUES(NEW.workspace_id,NEW.id,NEW.status,gocoach.actor_id());
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER enrollment_history AFTER INSERT OR UPDATE ON gocoach.enrollments FOR EACH ROW EXECUTE FUNCTION gocoach.enrollment_history_record();

CREATE FUNCTION gocoach.session_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, gocoach AS $fn$
BEGIN
  NEW.ends_at=NEW.starts_at+NEW.duration_minutes*interval '1 minute';
  UPDATE gocoach.users SET calendar_revision=calendar_revision+1
    WHERE workspace_id=NEW.workspace_id AND id=NEW.coach_id AND role='coach';
  IF NOT FOUND THEN RAISE EXCEPTION 'Session requires a coach' USING ERRCODE='23514'; END IF;
  IF NEW.status='scheduled' AND EXISTS (SELECT 1 FROM gocoach.sessions s WHERE s.workspace_id=NEW.workspace_id AND s.coach_id=NEW.coach_id AND s.id<>NEW.id AND s.status='scheduled' AND s.starts_at<NEW.ends_at AND s.ends_at>NEW.starts_at) THEN
    RAISE EXCEPTION 'Coach already has a session at this time' USING ERRCODE='23P01';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER session_guard BEFORE INSERT OR UPDATE ON gocoach.sessions FOR EACH ROW EXECUTE FUNCTION gocoach.session_guard();

CREATE FUNCTION gocoach.report_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, gocoach AS $fn$
DECLARE author_role text;
BEGIN
  SELECT role INTO author_role FROM gocoach.users WHERE workspace_id=NEW.workspace_id AND id=NEW.author_id;
  IF (NEW.kind='reflection' AND (author_role IS DISTINCT FROM 'participant' OR NEW.participant_id IS DISTINCT FROM NEW.author_id))
    OR (NEW.kind<>'reflection' AND author_role IS DISTINCT FROM 'coach') THEN
    RAISE EXCEPTION 'Report kind does not match its author' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (NEW.workspace_id,NEW.id,NEW.author_id,NEW.kind,NEW.cohort_id,NEW.participant_id) IS DISTINCT FROM (OLD.workspace_id,OLD.id,OLD.author_id,OLD.kind,OLD.cohort_id,OLD.participant_id) THEN
      RAISE EXCEPTION 'Create a new report to change its author, kind, or subject' USING ERRCODE='23514';
    END IF;
    NEW.revision=OLD.revision+1;
  ELSE NEW.revision=1;
  END IF;
  NEW.updated_at=now();
  IF NEW.status='published' THEN NEW.published_at=coalesce(NEW.published_at,now()); END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER report_guard BEFORE INSERT OR UPDATE ON gocoach.reports FOR EACH ROW EXECUTE FUNCTION gocoach.report_guard();
CREATE FUNCTION gocoach.report_version_record() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO gocoach.report_versions(workspace_id,report_id,revision,content) VALUES(NEW.workspace_id,NEW.id,NEW.revision,to_jsonb(NEW));
  RETURN NEW;
END $fn$;
CREATE TRIGGER report_version AFTER INSERT OR UPDATE ON gocoach.reports FOR EACH ROW EXECUTE FUNCTION gocoach.report_version_record();
CREATE FUNCTION gocoach.append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION '% is append-only',TG_TABLE_NAME USING ERRCODE='23514'; END $fn$;
DO $install$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['report_versions','audit_events','enrollment_history','lead_stage_history','subscription_events','contract_acknowledgements'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON gocoach.%I FOR EACH ROW EXECUTE FUNCTION gocoach.append_only()',relation);
  END LOOP;
END $install$;

CREATE FUNCTION gocoach.invoice_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, gocoach AS $fn$
BEGIN
  IF TG_OP='UPDATE' AND OLD.status<>'draft' THEN
    IF (NEW.buyer_id,NEW.cohort_id,NEW.currency,NEW.subtotal_minor,NEW.tax_minor,NEW.discount_minor,NEW.total_minor,NEW.billing_snapshot,NEW.number)
      IS DISTINCT FROM (OLD.buyer_id,OLD.cohort_id,OLD.currency,OLD.subtotal_minor,OLD.tax_minor,OLD.discount_minor,OLD.total_minor,OLD.billing_snapshot,OLD.number)
      OR NEW.status='draft' THEN
      RAISE EXCEPTION 'Issued invoice amounts and ownership are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.status='issued' THEN NEW.issued_at=coalesce(NEW.issued_at,now()); END IF;
  IF NEW.status='void' AND coalesce((SELECT sum(CASE kind WHEN 'refund' THEN -amount_minor ELSE amount_minor END) FROM gocoach.payments WHERE workspace_id=NEW.workspace_id AND invoice_id=NEW.id AND status='settled'),0)<>0 THEN
    RAISE EXCEPTION 'Refund the invoice before voiding it' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER invoice_guard BEFORE INSERT OR UPDATE ON gocoach.invoices FOR EACH ROW EXECUTE FUNCTION gocoach.invoice_guard();
CREATE FUNCTION gocoach.payment_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, gocoach AS $fn$
DECLARE invoice gocoach.invoices; net_paid bigint;
BEGIN
  IF TG_OP<>'INSERT' AND OLD.status='settled' THEN
    RAISE EXCEPTION 'Settled payments are immutable; record a refund instead' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  UPDATE gocoach.invoices SET payment_revision=payment_revision+1 WHERE workspace_id=NEW.workspace_id AND id=NEW.invoice_id RETURNING * INTO invoice;
  IF NEW.status='settled' THEN
    IF invoice.status IS DISTINCT FROM 'issued' THEN RAISE EXCEPTION 'Issue the invoice before recording payment' USING ERRCODE='23514'; END IF;
    SELECT coalesce(sum(CASE kind WHEN 'refund' THEN -amount_minor ELSE amount_minor END),0) INTO net_paid FROM gocoach.payments WHERE workspace_id=NEW.workspace_id AND invoice_id=NEW.invoice_id AND status='settled' AND id<>NEW.id;
    net_paid=net_paid+CASE NEW.kind WHEN 'refund' THEN -NEW.amount_minor ELSE NEW.amount_minor END;
    IF net_paid<0 OR net_paid>invoice.total_minor THEN RAISE EXCEPTION 'Payment or refund exceeds invoice balance' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER payment_guard BEFORE INSERT OR UPDATE OR DELETE ON gocoach.payments FOR EACH ROW EXECUTE FUNCTION gocoach.payment_guard();

CREATE FUNCTION gocoach.contract_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.status<>'draft' AND ((NEW.cohort_id,NEW.buyer_id,NEW.title,NEW.terms,NEW.amount_minor,NEW.currency,NEW.program_name,NEW.company_name,NEW.starts_on,NEW.ends_on,NEW.content_hash)
    IS DISTINCT FROM (OLD.cohort_id,OLD.buyer_id,OLD.title,OLD.terms,OLD.amount_minor,OLD.currency,OLD.program_name,OLD.company_name,OLD.starts_on,OLD.ends_on,OLD.content_hash) OR NEW.status='draft') THEN
    RAISE EXCEPTION 'An agreement sent for review cannot be rewritten' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER contract_guard BEFORE UPDATE ON gocoach.contracts FOR EACH ROW EXECUTE FUNCTION gocoach.contract_guard();
CREATE FUNCTION gocoach.acknowledgement_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, gocoach AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gocoach.contracts c JOIN gocoach.users u ON u.workspace_id=c.workspace_id AND u.buyer_id=c.buyer_id WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.contract_id AND c.status IN ('in-review','acknowledged','signed') AND u.id=NEW.user_id AND u.role='buyer') THEN
    RAISE EXCEPTION 'Only the owning buyer can acknowledge an agreement in review' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER acknowledgement_guard BEFORE INSERT ON gocoach.contract_acknowledgements FOR EACH ROW EXECUTE FUNCTION gocoach.acknowledgement_guard();

CREATE FUNCTION gocoach.next_invoice_number(tenant uuid, invoice_year integer)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,gocoach AS $fn$
DECLARE value bigint;
BEGIN
  INSERT INTO gocoach.invoice_counters(workspace_id,year,next_number) VALUES(tenant,invoice_year,2)
    ON CONFLICT (workspace_id,year) DO UPDATE SET next_number=gocoach.invoice_counters.next_number+1
    RETURNING next_number-1 INTO value;
  RETURN 'GC-'||invoice_year||'-'||lpad(value::text,greatest(3,length(value::text)),'0');
END $fn$;
