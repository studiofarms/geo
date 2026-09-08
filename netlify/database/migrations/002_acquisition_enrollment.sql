CREATE TABLE gocoach.inquiries (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  reference text NOT NULL,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  name text NOT NULL,
  email text NOT NULL,
  organization text NOT NULL DEFAULT '',
  interest text NOT NULL CHECK (interest IN ('sponsor', 'participant', 'syllabus')),
  message text NOT NULL DEFAULT '',
  consent_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, request_key),
  UNIQUE (workspace_id, reference)
);
CREATE TABLE gocoach.leads (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  inquiry_id uuid,
  buyer_id uuid,
  name text NOT NULL,
  email text NOT NULL,
  company text NOT NULL DEFAULT '',
  stage text NOT NULL DEFAULT 'discovery' CHECK (stage IN ('discovery', 'proposal', 'closed', 'lost')),
  value_minor bigint NOT NULL DEFAULT 0 CHECK (value_minor BETWEEN 0 AND 9007199254740991),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  note text NOT NULL DEFAULT '',
  owner_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, inquiry_id),
  FOREIGN KEY (workspace_id, inquiry_id) REFERENCES gocoach.inquiries(workspace_id, id),
  FOREIGN KEY (workspace_id, buyer_id) REFERENCES gocoach.buyers(workspace_id, id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES gocoach.users(workspace_id, id)
);
CREATE INDEX leads_pipeline_idx ON gocoach.leads(workspace_id, stage, created_at DESC);
CREATE TABLE gocoach.lead_stage_history (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL,
  from_stage text,
  to_stage text NOT NULL CHECK (to_stage IN ('discovery', 'proposal', 'closed', 'lost')),
  actor_id uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, lead_id) REFERENCES gocoach.leads(workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES gocoach.users(workspace_id, id)
);
CREATE TABLE gocoach.subscribers (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL,
  status text NOT NULL CHECK (status IN ('subscribed', 'unsubscribed')),
  consent_at timestamptz NOT NULL,
  unsubscribed_at timestamptz,
  unsubscribe_hash text NOT NULL CHECK (unsubscribe_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, unsubscribe_hash)
);
CREATE UNIQUE INDEX subscribers_email_unique ON gocoach.subscribers(workspace_id, lower(email));
CREATE TABLE gocoach.subscription_events (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subscriber_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('opt-in', 'opt-out')),
  source text NOT NULL,
  consent_text text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, subscriber_id) REFERENCES gocoach.subscribers(workspace_id, id)
);

CREATE TABLE gocoach.enrollments (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'enrolled', 'completed', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, cohort_id, participant_id),
  FOREIGN KEY (workspace_id, cohort_id) REFERENCES gocoach.cohorts(workspace_id, id),
  FOREIGN KEY (workspace_id, participant_id) REFERENCES gocoach.users(workspace_id, id)
);
CREATE INDEX enrollments_participant_idx ON gocoach.enrollments(workspace_id, participant_id, status);
CREATE TABLE gocoach.enrollment_history (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('invited', 'enrolled', 'completed', 'withdrawn')),
  actor_id uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, enrollment_id) REFERENCES gocoach.enrollments(workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES gocoach.users(workspace_id, id)
);
CREATE TABLE gocoach.invite_batches (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  created_by uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('csv', 'manual')),
  original_filename text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, cohort_id) REFERENCES gocoach.cohorts(workspace_id, id),
  FOREIGN KEY (workspace_id, created_by) REFERENCES gocoach.users(workspace_id, id)
);
CREATE TABLE gocoach.invite_batch_items (
  workspace_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  email text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'invited', 'already-enrolled', 'invalid', 'failed')),
  error_message text,
  PRIMARY KEY (workspace_id, batch_id, row_number),
  FOREIGN KEY (workspace_id, batch_id) REFERENCES gocoach.invite_batches(workspace_id, id)
);
CREATE TABLE gocoach.invitations (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  cohort_id uuid,
  batch_id uuid,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, token_hash),
  FOREIGN KEY (workspace_id, user_id) REFERENCES gocoach.users(workspace_id, id),
  FOREIGN KEY (workspace_id, cohort_id, user_id) REFERENCES gocoach.enrollments(workspace_id, cohort_id, participant_id),
  FOREIGN KEY (workspace_id, batch_id) REFERENCES gocoach.invite_batches(workspace_id, id),
  CHECK (expires_at > created_at),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX invitations_user_idx ON gocoach.invitations(workspace_id, user_id, cohort_id);
CREATE INDEX invitations_expiry_idx ON gocoach.invitations(expires_at) WHERE accepted_at IS NULL AND revoked_at IS NULL;
