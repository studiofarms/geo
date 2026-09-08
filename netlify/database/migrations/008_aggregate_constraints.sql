-- Deferred constraints allow a response plus all of its choices/answers to be
-- written atomically. Always submit them in one transaction.
CREATE FUNCTION gocoach.poll_integrity() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,gocoach AS $fn$
DECLARE tenant uuid; poll uuid; count_slots integer; cutoff timestamptz;
BEGIN
  tenant=coalesce(NEW.workspace_id,OLD.workspace_id);
  IF TG_TABLE_NAME='availability_polls' THEN poll=coalesce(NEW.id,OLD.id);
  ELSE poll=coalesce(NEW.poll_id,OLD.poll_id); END IF;
  SELECT deadline INTO cutoff FROM gocoach.availability_polls WHERE workspace_id=tenant AND id=poll;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO count_slots FROM gocoach.poll_slots WHERE workspace_id=tenant AND poll_id=poll;
  IF count_slots NOT BETWEEN 5 AND 20 OR EXISTS (SELECT 1 FROM gocoach.poll_slots WHERE workspace_id=tenant AND poll_id=poll AND starts_at<=cutoff) THEN
    RAISE EXCEPTION 'A poll needs 5-20 distinct slots after its deadline' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM gocoach.poll_responses r LEFT JOIN gocoach.poll_choices c USING(workspace_id,poll_id,participant_id)
    WHERE r.workspace_id=tenant AND r.poll_id=poll GROUP BY r.participant_id HAVING count(c.slot_id)<>5) THEN
    RAISE EXCEPTION 'Rank exactly five poll choices' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $fn$;
DO $install$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['availability_polls','poll_slots','poll_responses','poll_choices'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER poll_integrity AFTER INSERT OR UPDATE OR DELETE ON gocoach.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gocoach.poll_integrity()',relation);
  END LOOP;
END $install$;

CREATE FUNCTION gocoach.survey_integrity() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,gocoach AS $fn$
DECLARE tenant uuid; survey uuid; count_questions integer; current_status text;
BEGIN
  tenant=coalesce(NEW.workspace_id,OLD.workspace_id);
  IF TG_TABLE_NAME='surveys' THEN survey=coalesce(NEW.id,OLD.id);
  ELSE survey=coalesce(NEW.survey_id,OLD.survey_id); END IF;
  SELECT status INTO current_status FROM gocoach.surveys WHERE workspace_id=tenant AND id=survey;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*) INTO count_questions FROM gocoach.survey_questions WHERE workspace_id=tenant AND survey_id=survey;
  IF current_status<>'draft' AND count_questions NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'Open surveys need 1-10 questions' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM gocoach.survey_responses r LEFT JOIN gocoach.survey_answers a USING(workspace_id,survey_id,participant_id)
    WHERE r.workspace_id=tenant AND r.survey_id=survey GROUP BY r.participant_id HAVING count(a.question_id)<>count_questions OR count_questions=0) THEN
    RAISE EXCEPTION 'Answer every survey question' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $fn$;
DO $install$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['surveys','survey_questions','survey_responses','survey_answers'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER survey_integrity AFTER INSERT OR UPDATE OR DELETE ON gocoach.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gocoach.survey_integrity()',relation);
  END LOOP;
END $install$;
ALTER TABLE gocoach.surveys ADD COLUMN response_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE gocoach.availability_polls ADD COLUMN response_revision bigint NOT NULL DEFAULT 0;
CREATE FUNCTION gocoach.lock_response_parent() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,gocoach AS $fn$
DECLARE tenant uuid := coalesce(NEW.workspace_id,OLD.workspace_id); parent_id uuid; key_name text := TG_ARGV[0];
BEGIN
  parent_id=(coalesce(to_jsonb(NEW),to_jsonb(OLD))->>key_name)::uuid;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)->key_name) IS DISTINCT FROM (to_jsonb(OLD)->key_name) THEN
    RAISE EXCEPTION 'A response or question cannot move to another parent' USING ERRCODE='23514';
  END IF;
  IF key_name='survey_id' THEN
    UPDATE gocoach.surveys SET response_revision=response_revision+1 WHERE workspace_id=tenant AND id=parent_id;
  ELSE
    UPDATE gocoach.availability_polls SET response_revision=response_revision+1 WHERE workspace_id=tenant AND id=parent_id;
  END IF;
  RETURN coalesce(NEW,OLD);
END $fn$;
DO $install$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['survey_questions','survey_responses','survey_answers'] LOOP
    EXECUTE format('CREATE TRIGGER a_lock_response_parent BEFORE INSERT OR UPDATE OR DELETE ON gocoach.%I FOR EACH ROW EXECUTE FUNCTION gocoach.lock_response_parent(''survey_id'')',relation);
  END LOOP;
  FOREACH relation IN ARRAY ARRAY['poll_slots','poll_responses','poll_choices'] LOOP
    EXECUTE format('CREATE TRIGGER a_lock_response_parent BEFORE INSERT OR UPDATE OR DELETE ON gocoach.%I FOR EACH ROW EXECUTE FUNCTION gocoach.lock_response_parent(''poll_id'')',relation);
  END LOOP;
END $install$;
CREATE FUNCTION gocoach.freeze_survey_question() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,gocoach AS $fn$
DECLARE tenant uuid := coalesce(NEW.workspace_id,OLD.workspace_id); survey uuid := coalesce(NEW.survey_id,OLD.survey_id);
BEGIN
  IF EXISTS (SELECT 1 FROM gocoach.survey_responses WHERE workspace_id=tenant AND survey_id=survey) THEN
    RAISE EXCEPTION 'Survey questions are immutable after a response' USING ERRCODE='23514';
  END IF;
  RETURN coalesce(NEW,OLD);
END $fn$;
CREATE TRIGGER freeze_question BEFORE INSERT OR UPDATE OR DELETE ON gocoach.survey_questions FOR EACH ROW EXECUTE FUNCTION gocoach.freeze_survey_question();

CREATE FUNCTION gocoach.invoice_line_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,gocoach AS $fn$
DECLARE invoice_status text;
BEGIN
  UPDATE gocoach.invoices SET payment_revision=payment_revision+1
    WHERE workspace_id=coalesce(NEW.workspace_id,OLD.workspace_id) AND id=coalesce(NEW.invoice_id,OLD.invoice_id)
    RETURNING status INTO invoice_status;
  IF invoice_status<>'draft' THEN RAISE EXCEPTION 'Issued invoice lines are immutable' USING ERRCODE='23514'; END IF;
  RETURN coalesce(NEW,OLD);
END $fn$;
CREATE TRIGGER invoice_line_guard BEFORE INSERT OR UPDATE OR DELETE ON gocoach.invoice_lines FOR EACH ROW EXECUTE FUNCTION gocoach.invoice_line_guard();
CREATE FUNCTION gocoach.invoice_totals() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,gocoach AS $fn$
DECLARE tenant uuid; invoice uuid; subtotal bigint; invoice_status text; line_total bigint;
BEGIN
  tenant=coalesce(NEW.workspace_id,OLD.workspace_id);
  IF TG_TABLE_NAME='invoices' THEN invoice=coalesce(NEW.id,OLD.id);
  ELSE invoice=coalesce(NEW.invoice_id,OLD.invoice_id); END IF;
  SELECT subtotal_minor,status INTO subtotal,invoice_status FROM gocoach.invoices WHERE workspace_id=tenant AND id=invoice;
  IF NOT FOUND OR invoice_status='draft' THEN RETURN NULL; END IF;
  SELECT sum(amount_minor) INTO line_total FROM gocoach.invoice_lines WHERE workspace_id=tenant AND invoice_id=invoice;
  IF line_total IS NULL OR line_total<>subtotal THEN RAISE EXCEPTION 'Invoice subtotal must equal its line items' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $fn$;
CREATE CONSTRAINT TRIGGER invoice_totals AFTER INSERT OR UPDATE ON gocoach.invoices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gocoach.invoice_totals();
CREATE CONSTRAINT TRIGGER invoice_totals AFTER INSERT OR UPDATE OR DELETE ON gocoach.invoice_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gocoach.invoice_totals();

CREATE FUNCTION gocoach.lead_history_record() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP='INSERT' OR NEW.stage IS DISTINCT FROM OLD.stage THEN
    INSERT INTO gocoach.lead_stage_history(workspace_id,lead_id,from_stage,to_stage,actor_id)
      VALUES(NEW.workspace_id,NEW.id,CASE WHEN TG_OP='UPDATE' THEN OLD.stage END,NEW.stage,gocoach.actor_id());
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER lead_history AFTER INSERT OR UPDATE ON gocoach.leads FOR EACH ROW EXECUTE FUNCTION gocoach.lead_history_record();

CREATE FUNCTION gocoach.valid_time_zone() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW.time_zone) THEN
    RAISE EXCEPTION 'Use a recognized IANA time zone' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
DO $install$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['workspaces','cohorts','sessions','availability_rules'] LOOP
    EXECUTE format('CREATE TRIGGER valid_time_zone BEFORE INSERT OR UPDATE ON gocoach.%I FOR EACH ROW EXECUTE FUNCTION gocoach.valid_time_zone()',relation);
  END LOOP;
END $install$;
