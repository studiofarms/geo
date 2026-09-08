-- PostgreSQL 15+. No extensions, cloud-specific auth, database creation, or roles.
-- A workspace is a coaching practice; buyers are its sponsoring companies.
CREATE SCHEMA gocoach;
REVOKE ALL ON SCHEMA gocoach FROM PUBLIC;

CREATE TABLE gocoach.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  time_zone text NOT NULL DEFAULT 'America/Chicago',
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE gocoach.buyers (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (length(btrim(company)) BETWEEN 1 AND 160),
  contact_name text NOT NULL,
  contact_email text NOT NULL CHECK (contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  billing_email text NOT NULL,
  billing_address text NOT NULL DEFAULT '',
  tax_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE gocoach.users (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  email text NOT NULL CHECK (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role text NOT NULL CHECK (role IN ('coach', 'buyer', 'participant')),
  buyer_id uuid,
  active boolean NOT NULL DEFAULT true,
  email_verified_at timestamptz,
  calendar_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, buyer_id) REFERENCES gocoach.buyers(workspace_id, id),
  CHECK ((role = 'buyer') = (buyer_id IS NOT NULL))
);
CREATE UNIQUE INDEX users_email_unique ON gocoach.users(workspace_id, lower(email));
CREATE INDEX users_buyer_idx ON gocoach.users(workspace_id, buyer_id);

-- These tables are backend-only. Never put hashes or provider subjects in a DTO.
CREATE TABLE gocoach.user_credentials (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  password_hash text NOT NULL CHECK (length(password_hash) > 20),
  algorithm text NOT NULL DEFAULT 'scrypt',
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES gocoach.users(workspace_id, id)
);
CREATE TABLE gocoach.auth_identities (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, issuer, subject),
  FOREIGN KEY (workspace_id, user_id) REFERENCES gocoach.users(workspace_id, id)
);
CREATE TABLE gocoach.auth_sessions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, token_hash),
  FOREIGN KEY (workspace_id, user_id) REFERENCES gocoach.users(workspace_id, id),
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_expiry_idx ON gocoach.auth_sessions(expires_at);
CREATE INDEX auth_sessions_user_idx ON gocoach.auth_sessions(workspace_id, user_id);
CREATE TABLE gocoach.account_tokens (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('password-reset', 'email-verification')),
  token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, token_hash),
  FOREIGN KEY (workspace_id, user_id) REFERENCES gocoach.users(workspace_id, id),
  CHECK (expires_at > created_at)
);

CREATE TABLE gocoach.programs (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  duration_weeks smallint NOT NULL DEFAULT 12 CHECK (duration_weeks > 0),
  session_count smallint NOT NULL DEFAULT 6 CHECK (session_count > 0),
  session_minutes smallint NOT NULL DEFAULT 90 CHECK (session_minutes BETWEEN 15 AND 180),
  default_capacity smallint NOT NULL DEFAULT 7 CHECK (default_capacity BETWEEN 2 AND 50),
  price_minor bigint NOT NULL DEFAULT 120000 CHECK (price_minor BETWEEN 0 AND 9007199254740991),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  published boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE gocoach.cohorts (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL,
  program_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '',
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  time_zone text NOT NULL,
  capacity smallint NOT NULL CHECK (capacity BETWEEN 2 AND 50),
  price_minor bigint NOT NULL CHECK (price_minor BETWEEN 0 AND 9007199254740991),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'enrolling', 'active', 'completed')),
  enrollment_revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, id, buyer_id),
  FOREIGN KEY (workspace_id, buyer_id) REFERENCES gocoach.buyers(workspace_id, id),
  FOREIGN KEY (workspace_id, program_id) REFERENCES gocoach.programs(workspace_id, id),
  CHECK (ends_on > starts_on)
);
CREATE INDEX cohorts_buyer_idx ON gocoach.cohorts(workspace_id, buyer_id, status);
CREATE TABLE gocoach.cohort_coaches (
  workspace_id uuid NOT NULL,
  cohort_id uuid NOT NULL,
  coach_id uuid NOT NULL,
  is_lead boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, cohort_id, coach_id),
  FOREIGN KEY (workspace_id, cohort_id) REFERENCES gocoach.cohorts(workspace_id, id),
  FOREIGN KEY (workspace_id, coach_id) REFERENCES gocoach.users(workspace_id, id)
);
CREATE UNIQUE INDEX cohort_lead_unique ON gocoach.cohort_coaches(workspace_id, cohort_id) WHERE is_lead;

CREATE TABLE gocoach.buyer_private_notes (
  workspace_id uuid NOT NULL,
  buyer_id uuid NOT NULL,
  coach_id uuid NOT NULL,
  body text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, buyer_id, coach_id),
  FOREIGN KEY (workspace_id, buyer_id) REFERENCES gocoach.buyers(workspace_id, id),
  FOREIGN KEY (workspace_id, coach_id) REFERENCES gocoach.users(workspace_id, id)
);
