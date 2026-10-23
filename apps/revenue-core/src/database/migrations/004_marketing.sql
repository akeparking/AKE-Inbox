-- Additive marketing tables. All public input is scoped through a registered site.
CREATE TABLE IF NOT EXISTS marketing_sites (
 id text PRIMARY KEY, account_id bigint NOT NULL, name text NOT NULL, origin text NOT NULL,
 inbox_id bigint NOT NULL, enabled boolean NOT NULL DEFAULT false,
 settings jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,account_id)
);
CREATE TABLE IF NOT EXISTS marketing_consents (
 id uuid PRIMARY KEY, site_id text NOT NULL REFERENCES marketing_sites(id),
 choices jsonb NOT NULL, policy_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_visitors (
 id uuid PRIMARY KEY, site_id text NOT NULL REFERENCES marketing_sites(id),
 first_touch jsonb NOT NULL, consent_id uuid NOT NULL REFERENCES marketing_consents(id),
 created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz, UNIQUE(id,site_id)
);
CREATE TABLE IF NOT EXISTS marketing_visits (
 id uuid PRIMARY KEY, visitor_id uuid NOT NULL, site_id text NOT NULL,
 current_touch jsonb NOT NULL, coverage jsonb NOT NULL DEFAULT '{}',
 started_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(visitor_id,site_id) REFERENCES marketing_visitors(id,site_id) ON DELETE CASCADE,
 UNIQUE(id,site_id)
);
CREATE TABLE IF NOT EXISTS marketing_events (
 sequence bigserial PRIMARY KEY, event_id uuid NOT NULL, site_id text NOT NULL,
 visitor_id uuid NOT NULL, visit_id uuid NOT NULL, event_type text NOT NULL,
 request_hash text NOT NULL, data jsonb NOT NULL, client_at timestamptz,
 received_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(site_id,event_id),
 FOREIGN KEY(visitor_id,site_id) REFERENCES marketing_visitors(id,site_id) ON DELETE CASCADE,
 FOREIGN KEY(visit_id,site_id) REFERENCES marketing_visits(id,site_id) ON DELETE CASCADE,
 CHECK(event_type IN ('page_view','contact_click','form_submit_attempt','form_submit_failed','page_engagement'))
);
CREATE INDEX IF NOT EXISTS marketing_events_timeline ON marketing_events(visitor_id,sequence);
CREATE TABLE IF NOT EXISTS marketing_forms (
 id uuid PRIMARY KEY, site_id text NOT NULL REFERENCES marketing_sites(id), name text NOT NULL,
 draft jsonb NOT NULL, revision integer NOT NULL DEFAULT 0, published_version integer,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_form_versions (
 form_id uuid NOT NULL REFERENCES marketing_forms(id), version integer NOT NULL,
 definition jsonb NOT NULL, published_by bigint NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(form_id,version)
);
CREATE TABLE IF NOT EXISTS marketing_inquiries (
 id uuid PRIMARY KEY, site_id text NOT NULL REFERENCES marketing_sites(id),
 account_id bigint NOT NULL, source_submission_id text NOT NULL, source_kind text NOT NULL,
 request_hash text NOT NULL, payload text NOT NULL, visitor_id uuid REFERENCES marketing_visitors(id),
 visit_id uuid REFERENCES marketing_visits(id), consent_id uuid REFERENCES marketing_consents(id),
 form_id uuid, form_version integer, lead_id text REFERENCES leads(id),
 contact_id bigint, conversation_id bigint, message_id bigint,
 state text NOT NULL DEFAULT 'received', identity_state text NOT NULL DEFAULT 'unverified',
 revision integer NOT NULL DEFAULT 0, qualified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(site_id,source_submission_id), FOREIGN KEY(site_id,account_id) REFERENCES marketing_sites(id,account_id),
 FOREIGN KEY(form_id,form_version) REFERENCES marketing_form_versions(form_id,version)
);
CREATE INDEX IF NOT EXISTS marketing_inquiries_conversation ON marketing_inquiries(account_id,conversation_id);
CREATE TABLE IF NOT EXISTS marketing_links (
 id uuid PRIMARY KEY, inquiry_id uuid NOT NULL REFERENCES marketing_inquiries(id),
 visitor_id uuid REFERENCES marketing_visitors(id), basis text NOT NULL, evidence jsonb NOT NULL,
 actor_id text NOT NULL, reason text NOT NULL, supersedes uuid REFERENCES marketing_links(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS marketing_short_codes (
 code_hash text PRIMARY KEY, code_ciphertext text NOT NULL, site_id text NOT NULL REFERENCES marketing_sites(id),
 request_id uuid NOT NULL, request_hash text NOT NULL, visitor_id uuid NOT NULL REFERENCES marketing_visitors(id) ON DELETE CASCADE,
 visit_id uuid NOT NULL REFERENCES marketing_visits(id) ON DELETE CASCADE, binding_id text NOT NULL,
 expires_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'issued',
 inquiry_id uuid REFERENCES marketing_inquiries(id), claimed_contact_id bigint,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(site_id,request_id)
);
CREATE TABLE IF NOT EXISTS marketing_inbound_claims (
 account_id bigint NOT NULL, inbox_id bigint NOT NULL, message_id text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,inbox_id,message_id)
);
ALTER TABLE conversion_events ALTER COLUMN opportunity_id DROP NOT NULL;
ALTER TABLE conversion_deliveries ALTER COLUMN opportunity_id DROP NOT NULL;
ALTER TABLE conversion_deliveries ADD COLUMN IF NOT EXISTS receipt_stages jsonb NOT NULL DEFAULT '{"validation":"unknown","acceptance":"not_attempted","processing":"unknown","matching":"unknown"}';
CREATE TABLE IF NOT EXISTS conversion_attempts (
 id bigserial PRIMARY KEY, delivery_id text NOT NULL REFERENCES conversion_deliveries(id),
 attempt integer NOT NULL, mode text NOT NULL, stages jsonb NOT NULL, response_id text,
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(delivery_id,attempt)
);
