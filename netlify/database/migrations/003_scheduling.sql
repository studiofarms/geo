CREATE TABLE gocoach.availability_rules (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  time_zone text NOT NULL,
  slot_minutes smallint NOT NULL DEFAULT 30 CHECK (slot_minutes BETWEEN 15 AND 180),
  minimum_notice_minutes integer NOT NULL DEFAULT 120 CHECK (minimum_notice_minutes >= 0),
  booking_horizon_days integer NOT NULL DEFAULT 90 CHECK (booking_horizon_days > 0),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, coach_id) REFERENCES gocoach.users(workspace_id, id),
  CHECK (ends_at > starts_at)
);
CREATE TABLE gocoach.availability_exceptions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  coach_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  available boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT '',
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, coach_id) REFERENCES gocoach.users(workspace_id, id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX availability_exceptions_time_idx ON gocoach.availability_exceptions(workspace_id, coach_id, starts_at, ends_at);

CREATE TABLE gocoach.sessions (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cohort_id uuid,
  participant_id uuid,
  coach_id uuid NOT NULL,
  lead_id uuid,
  title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cohort', 'one-to-one', 'discovery')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'completed', 'cancelled')),
  starts_at timestamptz NOT NULL,
  duration_minutes smallint NOT NULL CHECK (duration_minutes BETWEEN 15 AND 180),
  ends_at timestamptz NOT NULL, -- maintained from starts_at/duration by a trigger
  time_zone text NOT NULL,
  meeting_url text CHECK (meeting_url IS NULL OR meeting_url ~ '^https://'),
  materials text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  cancellation_hash text CHECK (cancellation_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, id, cohort_id),
  UNIQUE (workspace_id, cancellation_hash),
  FOREIGN KEY (workspace_id, cohort_id) REFERENCES gocoach.cohorts(workspace_id, id),
  FOREIGN KEY (workspace_id, cohort_id, participant_id) REFERENCES gocoach.enrollments(workspace_id, cohort_id, participant_id),
  FOREIGN KEY (workspace_id, coach_id) REFERENCES gocoach.users(workspace_id, id),
  FOREIGN KEY (workspace_id, lead_id) REFERENCES gocoach.leads(workspace_id, id),
  CHECK ((kind = 'discovery' AND cohort_id IS NULL AND participant_id IS NULL)
    OR (kind = 'cohort' AND cohort_id IS NOT NULL AND participant_id IS NULL)
    OR (kind = 'one-to-one' AND cohort_id IS NOT NULL AND participant_id IS NOT NULL)),
  CHECK (ends_at > starts_at)
);
CREATE INDEX sessions_schedule_idx ON gocoach.sessions(workspace_id, coach_id, starts_at, ends_at) WHERE status = 'scheduled';
CREATE INDEX sessions_cohort_idx ON gocoach.sessions(workspace_id, cohort_id, starts_at);
CREATE INDEX sessions_participant_idx ON gocoach.sessions(workspace_id, participant_id, starts_at);
CREATE TABLE gocoach.session_contacts (
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  consent_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, session_id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES gocoach.sessions(workspace_id, id)
);
CREATE TABLE gocoach.session_private_notes (
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  coach_id uuid NOT NULL,
  body text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_id, coach_id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES gocoach.sessions(workspace_id, id),
  FOREIGN KEY (workspace_id, coach_id) REFERENCES gocoach.users(workspace_id, id)
);
CREATE TABLE gocoach.session_attendance (
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  cohort_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('expected', 'attended', 'absent', 'excused')),
  PRIMARY KEY (workspace_id, session_id, participant_id),
  FOREIGN KEY (workspace_id, session_id, cohort_id) REFERENCES gocoach.sessions(workspace_id, id, cohort_id),
  FOREIGN KEY (workspace_id, cohort_id, participant_id) REFERENCES gocoach.enrollments(workspace_id, cohort_id, participant_id)
);

CREATE TABLE gocoach.availability_polls (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  title text NOT NULL,
  deadline timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'closed')),
  winning_slot_id uuid,
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, id, cohort_id),
  FOREIGN KEY (workspace_id, cohort_id) REFERENCES gocoach.cohorts(workspace_id, id),
  FOREIGN KEY (workspace_id, confirmed_by) REFERENCES gocoach.users(workspace_id, id),
  CHECK ((status = 'confirmed') = (winning_slot_id IS NOT NULL)),
  CHECK (status <> 'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
);
CREATE TABLE gocoach.poll_slots (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  poll_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 19),
  starts_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, poll_id, id),
  UNIQUE (workspace_id, poll_id, position),
  UNIQUE (workspace_id, poll_id, starts_at),
  FOREIGN KEY (workspace_id, poll_id) REFERENCES gocoach.availability_polls(workspace_id, id)
);
ALTER TABLE gocoach.availability_polls ADD CONSTRAINT poll_winner_same_poll
  FOREIGN KEY (workspace_id, id, winning_slot_id) REFERENCES gocoach.poll_slots(workspace_id, poll_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE gocoach.poll_responses (
  workspace_id uuid NOT NULL,
  poll_id uuid NOT NULL,
  cohort_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, poll_id, participant_id),
  FOREIGN KEY (workspace_id, poll_id, cohort_id) REFERENCES gocoach.availability_polls(workspace_id, id, cohort_id),
  FOREIGN KEY (workspace_id, cohort_id, participant_id) REFERENCES gocoach.enrollments(workspace_id, cohort_id, participant_id)
);
CREATE TABLE gocoach.poll_choices (
  workspace_id uuid NOT NULL,
  poll_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  rank smallint NOT NULL CHECK (rank BETWEEN 1 AND 5),
  PRIMARY KEY (workspace_id, poll_id, participant_id, rank),
  UNIQUE (workspace_id, poll_id, participant_id, slot_id),
  FOREIGN KEY (workspace_id, poll_id, participant_id) REFERENCES gocoach.poll_responses(workspace_id, poll_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, poll_id, slot_id) REFERENCES gocoach.poll_slots(workspace_id, poll_id, id)
);
