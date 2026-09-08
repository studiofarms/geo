CREATE TABLE gocoach.integration_secrets (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  name text NOT NULL CHECK(name IN ('calendly-token','calendly-webhook-key')),
  encrypted_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,connection_id,name),
  FOREIGN KEY(workspace_id,connection_id) REFERENCES gocoach.integration_connections(workspace_id,id)
);
CREATE UNIQUE INDEX calendly_one_connection_idx ON gocoach.integration_connections(workspace_id,provider) WHERE provider='calendly';
CREATE TABLE gocoach.booking_contexts (
  workspace_id uuid NOT NULL,
  token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  cohort_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,token_hash),
  FOREIGN KEY(workspace_id,cohort_id,participant_id) REFERENCES gocoach.enrollments(workspace_id,cohort_id,participant_id)
);
CREATE INDEX booking_contexts_expiry_idx ON gocoach.booking_contexts(expires_at);
CREATE TABLE gocoach.calendly_bookings (
  workspace_id uuid NOT NULL,
  invitee_uri text NOT NULL,
  event_uri text NOT NULL,
  session_id uuid,
  status text NOT NULL CHECK(status IN ('active','canceled','unmatched')),
  provider_updated_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,invitee_uri),
  FOREIGN KEY(workspace_id,session_id) REFERENCES gocoach.sessions(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE gocoach.sessions ADD COLUMN provider text NOT NULL DEFAULT 'local';
ALTER TABLE gocoach.sessions ADD COLUMN reschedule_url text;
ALTER TABLE gocoach.sessions ADD COLUMN cancel_url text;
ALTER TABLE gocoach.sessions ADD CONSTRAINT calendly_links_https CHECK(
  (reschedule_url IS NULL OR reschedule_url ~ '^https://calendly[.]com/') AND
  (cancel_url IS NULL OR cancel_url ~ '^https://calendly[.]com/'));
DO $security$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['integration_secrets','booking_contexts','calendly_bookings'] LOOP
    EXECUTE format('ALTER TABLE gocoach.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('ALTER TABLE gocoach.%I FORCE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY workspace_isolation ON gocoach.%I USING (workspace_id=gocoach.workspace_id()) WITH CHECK(workspace_id=gocoach.workspace_id())',relation);
  END LOOP;
END $security$;
REVOKE ALL ON ALL TABLES IN SCHEMA gocoach FROM PUBLIC;
