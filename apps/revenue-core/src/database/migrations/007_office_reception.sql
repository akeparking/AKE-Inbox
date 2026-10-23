ALTER TABLE inbox_v2_conversations ADD COLUMN IF NOT EXISTS reception_managed boolean NOT NULL DEFAULT false;
ALTER TABLE inbox_v2_conversations ADD COLUMN IF NOT EXISTS reception_hold boolean NOT NULL DEFAULT false;
ALTER TABLE inbox_v2_conversations ADD COLUMN IF NOT EXISTS reception_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS inbox_v2_reception_active ON inbox_v2_conversations(account_id,updated_at) WHERE reception_managed;
