-- Additive, separate from v0.1 fictional sales records. No customer data is seeded.
CREATE TABLE IF NOT EXISTS inbox_v2_contacts (
 account_id bigint NOT NULL, contact_id bigint NOT NULL, group_key text NOT NULL,
 email_hash text, phone_hash text, blocked boolean NOT NULL DEFAULT false,
 opted_out boolean NOT NULL DEFAULT false, timezone text,
 profile text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,contact_id)
);
CREATE INDEX IF NOT EXISTS inbox_v2_identity_email ON inbox_v2_contacts(account_id,email_hash);
CREATE INDEX IF NOT EXISTS inbox_v2_identity_phone ON inbox_v2_contacts(account_id,phone_hash);
CREATE INDEX IF NOT EXISTS inbox_v2_contact_group ON inbox_v2_contacts(account_id,group_key);
CREATE TABLE IF NOT EXISTS inbox_v2_conversations (
 account_id bigint NOT NULL, conversation_id bigint NOT NULL, contact_id bigint NOT NULL,
 inbox_id bigint NOT NULL, channel text NOT NULL, mode text NOT NULL DEFAULT 'ai',
 revision integer NOT NULL DEFAULT 0, native_status text NOT NULL DEFAULT 'open',
 profile text NOT NULL, summary text, last_inbound_at timestamptz,
 followup_count integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,conversation_id)
);
CREATE TABLE IF NOT EXISTS inbox_v2_events (
 account_id bigint NOT NULL, event_key text NOT NULL, conversation_id bigint,
 kind text NOT NULL, payload text NOT NULL, occurred_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,event_key)
);
CREATE TABLE IF NOT EXISTS inbox_v2_jobs (
 id text PRIMARY KEY, account_id bigint NOT NULL, conversation_id bigint,
 group_key text, kind text NOT NULL, state text NOT NULL DEFAULT 'pending',
 revision integer, payload text NOT NULL, attempts integer NOT NULL DEFAULT 0,
 due_at timestamptz NOT NULL DEFAULT now(), claimed_at timestamptz,
 result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inbox_v2_jobs_due ON inbox_v2_jobs(state,due_at);
CREATE TABLE IF NOT EXISTS inbox_v2_links (
 account_id bigint NOT NULL, group_key text NOT NULL, lead_id text, company_id text,
 customer_ids jsonb NOT NULL DEFAULT '[]', snapshot text, refreshed_at timestamptz,
 PRIMARY KEY(account_id,group_key)
);
CREATE TABLE IF NOT EXISTS inbox_v2_writes (
 account_id bigint NOT NULL, operation_key text NOT NULL, kind text NOT NULL,
 request_hash text NOT NULL, state text NOT NULL, remote_id text, receipt jsonb,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,operation_key)
);
CREATE TABLE IF NOT EXISTS inbox_v2_knowledge (
 id text NOT NULL, version integer NOT NULL, title text NOT NULL, body text NOT NULL,
 source_id text NOT NULL, source_hash text NOT NULL, tags jsonb NOT NULL DEFAULT '{}',
 state text NOT NULL DEFAULT 'draft', reviewed_by text, reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(id,version)
);
CREATE TABLE IF NOT EXISTS inbox_v2_audit (
 id bigserial PRIMARY KEY, account_id bigint NOT NULL, actor text NOT NULL,
 action text NOT NULL, target text NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inbox_v2_sessions (
 token_hash text PRIMARY KEY, account_id bigint NOT NULL, user_id bigint NOT NULL,
 role text NOT NULL, credentials text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_v2_exports (
 id text PRIMARY KEY, account_id bigint NOT NULL, user_id bigint NOT NULL,
 state text NOT NULL DEFAULT 'pending', format text NOT NULL, filters text NOT NULL,
 file_name text, sha256 text, error text, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inbox_v2_settings (
 account_id bigint NOT NULL, key text NOT NULL, value jsonb NOT NULL,
 PRIMARY KEY(account_id,key)
);

ALTER TABLE inbox_v2_contacts ADD COLUMN IF NOT EXISTS identity_verified boolean NOT NULL DEFAULT false;
