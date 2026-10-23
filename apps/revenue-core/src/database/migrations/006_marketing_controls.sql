ALTER TABLE inbox_v2_contacts ADD COLUMN IF NOT EXISTS identity_conflict boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS marketing_bridge_owners (
 account_id bigint NOT NULL,inbox_id bigint NOT NULL,provider text NOT NULL CHECK(provider IN ('paused','waha','evolution')),
 revision integer NOT NULL DEFAULT 0,cutoff_message_id bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,inbox_id)
);
CREATE TABLE IF NOT EXISTS marketing_bridge_dispatches (
 account_id bigint NOT NULL,inbox_id bigint NOT NULL,message_id bigint NOT NULL,provider text NOT NULL,
 state text NOT NULL,parts integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,inbox_id,message_id)
);
CREATE INDEX IF NOT EXISTS marketing_inquiries_pagination ON marketing_inquiries(account_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS marketing_visitors_pagination ON marketing_visitors(site_id,last_seen_at DESC,id DESC);
