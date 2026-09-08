-- Runtime support for the existing frontend's transaction-oriented API.
-- Core data continues to live in the normalized tables from migrations 001-009.
CREATE TABLE gocoach.workspace_settings (
  workspace_id uuid PRIMARY KEY REFERENCES gocoach.workspaces(id),
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Small prototype uploads are transactional, portable and private in PostgreSQL.
-- Object-store locators in file_objects remain available for a later storage adapter.
CREATE TABLE gocoach.file_contents (
  workspace_id uuid NOT NULL,
  file_id uuid NOT NULL,
  contents bytea NOT NULL CHECK (octet_length(contents) BETWEEN 1 AND 3145728),
  PRIMARY KEY(workspace_id,file_id),
  FOREIGN KEY(workspace_id,file_id) REFERENCES gocoach.file_objects(workspace_id,id)
);
CREATE TABLE gocoach.reminder_receipts (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,key)
);
CREATE TABLE gocoach.rate_limit_buckets (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  key text NOT NULL,
  attempts integer NOT NULL CHECK(attempts>0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,key)
);
CREATE INDEX rate_limit_expiry_idx ON gocoach.rate_limit_buckets(expires_at);
ALTER TABLE gocoach.leads ADD COLUMN inquiry_reference text;
CREATE UNIQUE INDEX leads_inquiry_reference_idx ON gocoach.leads(workspace_id,inquiry_reference) WHERE inquiry_reference IS NOT NULL;
-- A hook is a durable outbox event; retain whether the integration is connected.
ALTER TABLE gocoach.outbox_events ADD COLUMN integration_status text NOT NULL DEFAULT 'not-connected';

DO $security$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['workspace_settings','file_contents','reminder_receipts','rate_limit_buckets'] LOOP
    EXECUTE format('ALTER TABLE gocoach.%I ENABLE ROW LEVEL SECURITY',relation);
    EXECUTE format('CREATE POLICY workspace_isolation ON gocoach.%I USING (workspace_id=gocoach.workspace_id()) WITH CHECK(workspace_id=gocoach.workspace_id())',relation);
  END LOOP;
  -- Netlify supplies a server-only connection. FORCE also applies RLS when that
  -- connection owns the tables, unless its role is SUPERUSER or BYPASSRLS.
  FOR relation IN SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='gocoach' LOOP
    EXECUTE format('ALTER TABLE gocoach.%I FORCE ROW LEVEL SECURITY',relation);
  END LOOP;
END $security$;
REVOKE ALL ON ALL TABLES IN SCHEMA gocoach FROM PUBLIC;
