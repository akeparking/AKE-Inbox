-- Manual Meta feedback is independent of Google's queue and of OKKI polling.
CREATE TABLE IF NOT EXISTS marketing_meta_feedback (
 id uuid PRIMARY KEY, account_id bigint NOT NULL,
 inquiry_id uuid NOT NULL REFERENCES marketing_inquiries(id),
 subject_key text NOT NULL, source_type text NOT NULL CHECK(source_type IN ('website','instant_form')),
 mode text NOT NULL CHECK(mode IN ('mock','test','live')), dataset_id text NOT NULL,
 event_name text NOT NULL CHECK(event_name IN ('Lead','QualifiedLead','ConvertedLead')),
 event_id text NOT NULL, occurred_at timestamptz NOT NULL, payload text NOT NULL,
 status text NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','sending','accepted','mock','test','rejected','review')),
 actor_id bigint NOT NULL, evidence text NOT NULL, attempt_count integer NOT NULL DEFAULT 0,
 response_id text, error_code text, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,dataset_id,mode,subject_key,event_name),
 UNIQUE(dataset_id,mode,event_name,event_id)
);
CREATE INDEX IF NOT EXISTS marketing_meta_feedback_inquiry ON marketing_meta_feedback(account_id,inquiry_id);
CREATE TABLE IF NOT EXISTS marketing_meta_attempts (
 id bigserial PRIMARY KEY, feedback_id uuid NOT NULL REFERENCES marketing_meta_feedback(id),
 attempt integer NOT NULL, actor_id bigint NOT NULL, status text NOT NULL,
 response_id text, error_code text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(feedback_id,attempt)
);
