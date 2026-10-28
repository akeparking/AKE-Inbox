-- Imported historical receipts block a second sender without inventing Inbox inquiries.
CREATE TABLE IF NOT EXISTS marketing_meta_legacy_receipts (
 id text PRIMARY KEY, account_id bigint NOT NULL, dataset_id text NOT NULL,
 subject_key text NOT NULL, event_name text NOT NULL, event_id text NOT NULL,
 occurred_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('accepted','sent_in_error','review')),
 response_id text, evidence text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(dataset_id,event_name,event_id)
);
CREATE INDEX IF NOT EXISTS marketing_meta_legacy_subject ON marketing_meta_legacy_receipts(dataset_id,subject_key,event_name);
