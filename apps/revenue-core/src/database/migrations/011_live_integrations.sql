-- Optional official Meta form polling complements signed Webhooks.
CREATE TABLE IF NOT EXISTS crm_lead_sync_state (
  workspace_id text NOT NULL REFERENCES workspaces(id), provider text NOT NULL,
  next_run_at timestamptz NOT NULL DEFAULT now(), last_success_at timestamptz,
  PRIMARY KEY(workspace_id,provider)
);
CREATE TABLE IF NOT EXISTS crm_lead_sync_runs (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), provider text NOT NULL,
  state text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  received_count integer NOT NULL DEFAULT 0, error_code text
);
CREATE INDEX IF NOT EXISTS crm_lead_sync_recent ON crm_lead_sync_runs(workspace_id,started_at DESC);
ALTER TABLE crm_ai_suggestions ADD COLUMN IF NOT EXISTS requested_model text;
ALTER TABLE crm_ai_suggestions ADD COLUMN IF NOT EXISTS returned_model text;
