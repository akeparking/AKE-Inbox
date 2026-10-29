-- Additive schema. RLS is enabled separately on a dedicated SaaS database.
CREATE TABLE IF NOT EXISTS saas_tenants (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id), slug text UNIQUE NOT NULL,
  chatwoot_account_id bigint UNIQUE NOT NULL, chatwoot_url text NOT NULL,
  enabled boolean NOT NULL DEFAULT false, effective_from timestamptz NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}', secrets text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saas_members (
  workspace_id text NOT NULL REFERENCES saas_tenants(workspace_id), user_id text NOT NULL,
  role text NOT NULL CHECK(role IN ('admin','marketing','sales','viewer')),
  active boolean NOT NULL DEFAULT true, PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS saas_sessions (
  token_hash text PRIMARY KEY, workspace_id text NOT NULL REFERENCES saas_tenants(workspace_id),
  user_id text NOT NULL, credentials text NOT NULL, expires_at timestamptz NOT NULL,
  FOREIGN KEY(workspace_id,user_id) REFERENCES saas_members(workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS saas_invitations (
  token_hash text PRIMARY KEY, workspace_id text NOT NULL REFERENCES saas_tenants(workspace_id),
  user_id text NOT NULL, role text NOT NULL CHECK(role IN ('admin','marketing','sales','viewer')),
  expires_at timestamptz NOT NULL, accepted_at timestamptz
);
CREATE TABLE IF NOT EXISTS saas_login_attempts (
  workspace_id text NOT NULL, identity_hash text NOT NULL, count integer NOT NULL, started_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,identity_hash)
);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS industry text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
ALTER TABLE people ADD COLUMN IF NOT EXISTS buying_role text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS result text;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS lost_reason text;
ALTER TABLE opportunities ALTER COLUMN direction DROP NOT NULL;
ALTER TABLE opportunities ALTER COLUMN country DROP NOT NULL;
ALTER TABLE opportunities ALTER COLUMN currency DROP NOT NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS received_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ownership_system text NOT NULL DEFAULT 'inbox';
CREATE TABLE IF NOT EXISTS crm_quotes (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), opportunity_id text NOT NULL REFERENCES opportunities(id),
  version integer NOT NULL, title text NOT NULL, amount numeric(18,2), currency char(3) NOT NULL,
  notes text NOT NULL DEFAULT '', previous_id text REFERENCES crm_quotes(id), created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,opportunity_id,version)
);
ALTER TABLE crm_quotes ALTER COLUMN currency DROP NOT NULL;
CREATE TABLE IF NOT EXISTS crm_outcomes (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), opportunity_id text NOT NULL REFERENCES opportunities(id),
  status text NOT NULL CHECK(status IN ('won','lost','reopened')), amount numeric(18,2), currency char(3),
  occurred_at timestamptz NOT NULL, evidence text NOT NULL, actor_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saas_operations (
  workspace_id text NOT NULL REFERENCES workspaces(id), operation_key text NOT NULL, request_hash text NOT NULL,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,operation_key)
);
CREATE TABLE IF NOT EXISTS crm_business_events (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), opportunity_id text REFERENCES opportunities(id),
  lead_id text REFERENCES leads(id), kind text NOT NULL, occurred_at timestamptz NOT NULL,
  payload jsonb NOT NULL, mode text NOT NULL DEFAULT 'mock', status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,opportunity_id,kind)
);
CREATE TABLE IF NOT EXISTS crm_channels (
  workspace_id text NOT NULL REFERENCES workspaces(id), inbox_id bigint NOT NULL,
  channel text NOT NULL CHECK(channel IN ('website','email','whatsapp')), enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY(workspace_id,inbox_id)
);
CREATE TABLE IF NOT EXISTS crm_conversation_links (
  workspace_id text NOT NULL REFERENCES workspaces(id), conversation_id bigint NOT NULL,
  lead_id text NOT NULL REFERENCES leads(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,conversation_id)
);
CREATE TABLE IF NOT EXISTS crm_outbound (
  workspace_id text NOT NULL REFERENCES workspaces(id), operation_key text NOT NULL,
  conversation_id bigint NOT NULL, request_hash text NOT NULL, state text NOT NULL,
  provider_id text, error_code text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,operation_key)
);
CREATE TABLE IF NOT EXISTS crm_knowledge (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), title text NOT NULL, body text NOT NULL,
  source text NOT NULL, source_hash text NOT NULL, state text NOT NULL, version integer NOT NULL DEFAULT 0,
  reviewed_by text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS crm_ai_suggestions (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), lead_id text NOT NULL REFERENCES leads(id),
  kind text NOT NULL, result text NOT NULL, provider text NOT NULL, sources jsonb NOT NULL DEFAULT '[]',
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ad_connections (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), provider text NOT NULL CHECK(provider IN ('meta','google')),
  name text NOT NULL, account_id text NOT NULL, currency char(3) NOT NULL, timezone text NOT NULL,
  enabled boolean NOT NULL DEFAULT false, mode text NOT NULL DEFAULT 'mock', api_version text NOT NULL,
  conversion_metric text NOT NULL DEFAULT '', credentials text NOT NULL, status text NOT NULL DEFAULT 'unverified',
  last_sync_at timestamptz, next_sync_at timestamptz NOT NULL DEFAULT now(), last_backfill_date date,
  lease_until timestamptz, version integer NOT NULL DEFAULT 0,
  UNIQUE(workspace_id,provider,account_id)
);
CREATE TABLE IF NOT EXISTS ad_sync_runs (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), connection_id text NOT NULL REFERENCES ad_connections(id),
  date_from date NOT NULL, date_to date NOT NULL, state text NOT NULL, row_count integer,
  error_code text, cursor jsonb NOT NULL DEFAULT '{}', started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS ad_metric_daily (
  workspace_id text NOT NULL REFERENCES workspaces(id), connection_id text NOT NULL REFERENCES ad_connections(id),
  date date NOT NULL, campaign_id text NOT NULL, campaign_name text NOT NULL,
  spend numeric(18,6), impressions bigint, clicks bigint, platform_conversions numeric(18,6),
  complete boolean NOT NULL DEFAULT false, run_id text NOT NULL REFERENCES ad_sync_runs(id), synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,connection_id,date,campaign_id)
);
CREATE TABLE IF NOT EXISTS crm_ingestion_receipts (
  workspace_id text NOT NULL REFERENCES workspaces(id), source text NOT NULL, event_id text NOT NULL,
  payload_hash text NOT NULL, lead_id text REFERENCES leads(id), state text NOT NULL,
  occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,source,event_id)
);
CREATE TABLE IF NOT EXISTS ad_sync_days (
  workspace_id text NOT NULL REFERENCES workspaces(id), connection_id text NOT NULL REFERENCES ad_connections(id),
  date date NOT NULL, run_id text NOT NULL REFERENCES ad_sync_runs(id), synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,connection_id,date)
);
CREATE TABLE IF NOT EXISTS crm_feedback_attempts (
  workspace_id text NOT NULL REFERENCES workspaces(id),event_key text NOT NULL,provider text NOT NULL,mode text NOT NULL,
  state text NOT NULL,payload_hash text NOT NULL,receipt jsonb,error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,event_key)
);
CREATE TABLE IF NOT EXISTS crm_feedback_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),event_key text NOT NULL,
  payload_hash text NOT NULL,receipt jsonb,error_code text,reason text NOT NULL,actor_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
-- Tenant-qualified references prevent accidental cross-workspace relationships even before reads.
DO $$ DECLARE t text; r record; BEGIN
  FOREACH t IN ARRAY ARRAY['companies','people','leads','opportunities','attribution_touches','crm_quotes','ad_connections','ad_sync_runs'] LOOP
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I(workspace_id,id)', t||'_tenant_id_uq', t);
  END LOOP;
  FOR r IN SELECT * FROM (VALUES
    ('people','company_id','companies'),('leads','person_id','people'),('leads','company_id','companies'),
    ('opportunities','person_id','people'),('opportunities','company_id','companies'),('opportunities','primary_source_lead_id','leads'),
    ('crm_tasks','lead_id','leads'),('crm_tasks','opportunity_id','opportunities'),('crm_notes','lead_id','leads'),('crm_notes','opportunity_id','opportunities'),
    ('crm_quotes','opportunity_id','opportunities'),('crm_quotes','previous_id','crm_quotes'),('crm_outcomes','opportunity_id','opportunities'),
    ('crm_conversation_links','lead_id','leads'),('crm_ai_suggestions','lead_id','leads'),('crm_ingestion_receipts','lead_id','leads'),
    ('ad_sync_runs','connection_id','ad_connections'),('ad_metric_daily','connection_id','ad_connections'),('ad_metric_daily','run_id','ad_sync_runs'),
    ('ad_sync_days','connection_id','ad_connections'),('ad_sync_days','run_id','ad_sync_runs'),
    ('crm_business_events','lead_id','leads'),('crm_business_events','opportunity_id','opportunities'),
    ('attribution_touches','lead_id','leads'),('ad_identifiers','attribution_touch_id','attribution_touches')
  ) AS v(tab,col,parent) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname=r.tab||'_'||r.col||'_tenant_fk') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(workspace_id,%I) REFERENCES %I(workspace_id,id) NOT VALID',r.tab,r.tab||'_'||r.col||'_tenant_fk',r.col,r.parent);
    END IF;
  END LOOP;
END $$;
