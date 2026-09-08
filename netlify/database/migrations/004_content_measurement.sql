-- Store bytes in local disk, S3, GCS, Azure Blob, R2, etc.; store only locators here.
CREATE TABLE gocoach.file_objects (
  workspace_id uuid NOT NULL REFERENCES gocoach.workspaces(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  storage_backend text NOT NULL,
  bucket text NOT NULL DEFAULT '',
  object_key text NOT NULL,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  scan_status text NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, storage_backend, bucket, object_key)
);
CREATE TABLE gocoach.documents (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  participant_id uuid,
  session_id uuid,
  file_id uuid NOT NULL,
  uploaded_by uuid NOT NULL,
  title text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('cohort', 'individual', 'buyer', 'private')),
  phase text NOT NULL DEFAULT 'resource' CHECK (phase IN ('resource', 'before', 'after')),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, cohort_id) REFERENCES gocoach.cohorts(workspace_id, id),
  FOREIGN KEY (workspace_id, cohort_id, participant_id) REFERENCES gocoach.enrollments(workspace_id, cohort_id, participant_id),
  FOREIGN KEY (workspace_id, session_id, cohort_id) REFERENCES gocoach.sessions(workspace_id, id, cohort_id),
  FOREIGN KEY (workspace_id, file_id) REFERENCES gocoach.file_objects(workspace_id, id),
  FOREIGN KEY (workspace_id, uploaded_by) REFERENCES gocoach.users(workspace_id, id),
  CHECK ((scope = 'individual') = (participant_id IS NOT NULL))
);
CREATE INDEX documents_library_idx ON gocoach.documents(workspace_id, cohort_id, scope) WHERE archived_at IS NULL;

CREATE TABLE gocoach.reports (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  participant_id uuid,
  author_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reflection', 'coach-evaluation', 'cohort', 'end-of-program')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 180),
  highlights text NOT NULL CHECK (length(btrim(highlights)) BETWEEN 1 AND 10000),
  progress text NOT NULL DEFAULT '' CHECK (length(progress) <= 10000),
  next_steps text NOT NULL DEFAULT '' CHECK (length(next_steps) <= 10000),
  share_buyer boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, cohort_id) REFERENCES gocoach.cohorts(workspace_id, id),
  FOREIGN KEY (workspace_id, cohort_id, participant_id) REFERENCES gocoach.enrollments(workspace_id, cohort_id, participant_id),
  FOREIGN KEY (workspace_id, author_id) REFERENCES gocoach.users(workspace_id, id),
  CHECK ((kind IN ('reflection', 'coach-evaluation')) = (participant_id IS NOT NULL)),
  CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE INDEX reports_cohort_idx ON gocoach.reports(workspace_id, cohort_id, status, updated_at DESC);
CREATE INDEX reports_evaluation_idx ON gocoach.reports(workspace_id, cohort_id, participant_id, published_at DESC)
  WHERE kind = 'coach-evaluation' AND status = 'published' AND share_buyer;
CREATE TABLE gocoach.report_versions (
  workspace_id uuid NOT NULL,
  report_id uuid NOT NULL,
  revision integer NOT NULL,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, report_id, revision),
  FOREIGN KEY (workspace_id, report_id) REFERENCES gocoach.reports(workspace_id, id)
);

CREATE TABLE gocoach.surveys (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  title text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('pre', 'mid', 'post')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  deadline timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, id, cohort_id),
  FOREIGN KEY (workspace_id, cohort_id) REFERENCES gocoach.cohorts(workspace_id, id)
);
CREATE TABLE gocoach.survey_questions (
  workspace_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  survey_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 9),
  prompt text NOT NULL CHECK (length(btrim(prompt)) BETWEEN 1 AND 300),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, survey_id, id),
  UNIQUE (workspace_id, survey_id, position),
  FOREIGN KEY (workspace_id, survey_id) REFERENCES gocoach.surveys(workspace_id, id)
);
CREATE TABLE gocoach.survey_responses (
  workspace_id uuid NOT NULL,
  survey_id uuid NOT NULL,
  cohort_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  reflection text NOT NULL DEFAULT '' CHECK (length(reflection) <= 5000),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, survey_id, participant_id),
  FOREIGN KEY (workspace_id, survey_id, cohort_id) REFERENCES gocoach.surveys(workspace_id, id, cohort_id),
  FOREIGN KEY (workspace_id, cohort_id, participant_id) REFERENCES gocoach.enrollments(workspace_id, cohort_id, participant_id)
);
CREATE TABLE gocoach.survey_answers (
  workspace_id uuid NOT NULL,
  survey_id uuid NOT NULL,
  participant_id uuid NOT NULL,
  question_id uuid NOT NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  PRIMARY KEY (workspace_id, survey_id, participant_id, question_id),
  FOREIGN KEY (workspace_id, survey_id, participant_id) REFERENCES gocoach.survey_responses(workspace_id, survey_id, participant_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, survey_id, question_id) REFERENCES gocoach.survey_questions(workspace_id, survey_id, id)
);
