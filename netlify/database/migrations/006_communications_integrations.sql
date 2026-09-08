CREATE TABLE gocoach.messages (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, sender_id) REFERENCES gocoach.users(workspace_id, id),
  FOREIGN KEY (workspace_id, recipient_id) REFERENCES gocoach.users(workspace_id, id),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX messages_inbox_idx ON gocoach.messages(workspace_id, recipient_id, created_at DESC);
CREATE INDEX messages_sent_idx ON gocoach.messages(workspace_id, sender_id, created_at DESC);
CREATE TABLE gocoach.notifications (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  target text NOT NULL DEFAULT 'dashboard',
  deduplication_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, user_id, deduplication_key),
  FOREIGN KEY (workspace_id, user_id) REFERENCES gocoach.users(workspace_id, id)
);
CREATE INDEX notifications_unread_idx ON gocoach.notifications(workspace_id, user_id, created_at DESC) WHERE read_at IS NULL;
CREATE TABLE gocoach.reminder_rules (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_kind text NOT NULL CHECK (event_kind IN ('session', 'poll', 'survey', 'invoice')),
  hours_before integer NOT NULL CHECK (hours_before BETWEEN 1 AND 168),
  channel text NOT NULL CHECK (channel IN ('in-app', 'email')),
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, event_kind, hours_before, channel)
);
CREATE TABLE gocoach.reminder_deliveries (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL,
  user_id uuid NOT NULL,
  event_kind text NOT NULL,
  event_id uuid NOT NULL,
  event_starts_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'queued', 'sent', 'failed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, rule_id, user_id, event_kind, event_id, event_starts_at),
  FOREIGN KEY (workspace_id, rule_id) REFERENCES gocoach.reminder_rules(workspace_id, id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES gocoach.users(workspace_id, id)
);

CREATE TABLE gocoach.integration_connections (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid,
  provider text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('calendar', 'video', 'email', 'payments', 'signatures')),
  status text NOT NULL DEFAULT 'not-connected' CHECK (status IN ('not-connected', 'active', 'expired', 'revoked', 'error')),
  external_account_id text,
  credential_reference text, -- secret-manager reference, never an OAuth token
  configuration jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(configuration) = 'object'),
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES gocoach.users(workspace_id, id)
);
CREATE TABLE gocoach.calendar_events (
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  session_id uuid NOT NULL,
  external_event_id text,
  external_calendar_id text,
  sync_status text NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'error', 'deleted')),
  provider_etag text,
  synced_at timestamptz,
  PRIMARY KEY (workspace_id, connection_id, session_id),
  UNIQUE (workspace_id, connection_id, external_event_id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES gocoach.integration_connections(workspace_id, id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES gocoach.sessions(workspace_id, id)
);

-- Insert business changes and outbox events in ONE database transaction.
-- Workers claim ready events using FOR UPDATE SKIP LOCKED and a bounded lease.
CREATE TABLE gocoach.outbox_events (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid,
  deduplication_key text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, deduplication_key)
);
CREATE INDEX outbox_claim_idx ON gocoach.outbox_events(workspace_id, available_at, created_at) WHERE status IN ('pending', 'processing');
CREATE TABLE gocoach.email_deliveries (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  outbox_id uuid,
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  deduplication_key text NOT NULL,
  status text NOT NULL DEFAULT 'draft-local' CHECK (status IN ('draft-local', 'queued', 'sent', 'delivered', 'bounced', 'failed')),
  provider text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, deduplication_key),
  FOREIGN KEY (workspace_id, outbox_id) REFERENCES gocoach.outbox_events(workspace_id, id)
);
CREATE TABLE gocoach.webhook_events (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL,
  external_event_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  signature_verified_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, connection_id, external_event_id),
  FOREIGN KEY (workspace_id, connection_id) REFERENCES gocoach.integration_connections(workspace_id, id)
);
CREATE TABLE gocoach.idempotency_requests (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  scope text NOT NULL, -- include route and authenticated actor ID, or public operation
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response_status smallint CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, scope, request_key),
  CHECK (expires_at > created_at)
);
CREATE INDEX idempotency_expiry_idx ON gocoach.idempotency_requests(expires_at);
CREATE TABLE gocoach.audit_events (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  request_key uuid,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES gocoach.users(workspace_id, id)
);
CREATE INDEX audit_entity_idx ON gocoach.audit_events(workspace_id, entity_type, entity_id, occurred_at DESC);

-- Preserve legacy demo/string IDs when moving the JSON store to UUID keys.
CREATE TABLE gocoach.legacy_id_map (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  entity_type text NOT NULL,
  legacy_id text NOT NULL,
  new_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, entity_type, legacy_id),
  UNIQUE (workspace_id, entity_type, new_id)
);
