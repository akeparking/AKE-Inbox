CREATE TABLE IF NOT EXISTS marketing_waha_sends (
 key text PRIMARY KEY,account_id bigint NOT NULL,inbox_id bigint NOT NULL,
 conversation_id bigint NOT NULL,message_id bigint NOT NULL,part integer NOT NULL,
 session text NOT NULL,request_hash text NOT NULL,state text NOT NULL,
 response_id text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,inbox_id,message_id,part)
);
