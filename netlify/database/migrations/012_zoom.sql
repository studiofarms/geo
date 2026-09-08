ALTER TABLE gocoach.integration_secrets DROP CONSTRAINT integration_secrets_name_check;
ALTER TABLE gocoach.integration_secrets ADD CONSTRAINT integration_secrets_name_check
  CHECK(name IN ('calendly-token','calendly-webhook-key','zoom-credentials'));
CREATE UNIQUE INDEX zoom_one_connection_idx ON gocoach.integration_connections(workspace_id,provider) WHERE provider='zoom';
CREATE TABLE gocoach.zoom_meetings (
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  meeting_id text CHECK(meeting_id ~ '^[0-9]{9,15}$'),
  status text NOT NULL CHECK(status IN ('pending','active','deleted')),
  synced_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,session_id),
  FOREIGN KEY(workspace_id,session_id) REFERENCES gocoach.sessions(workspace_id,id),
  FOREIGN KEY(workspace_id,connection_id) REFERENCES gocoach.integration_connections(workspace_id,id)
);
CREATE UNIQUE INDEX zoom_meeting_id_idx ON gocoach.zoom_meetings(workspace_id,meeting_id) WHERE meeting_id IS NOT NULL;
ALTER TABLE gocoach.zoom_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE gocoach.zoom_meetings FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON gocoach.zoom_meetings
  USING(workspace_id=gocoach.workspace_id()) WITH CHECK(workspace_id=gocoach.workspace_id());
REVOKE ALL ON gocoach.zoom_meetings FROM PUBLIC;
