CREATE TABLE IF NOT EXISTS blob_cleanup_queue (
  id BIGSERIAL PRIMARY KEY,
  store_name TEXT NOT NULL CHECK (store_name IN ('customer-logos', 'completed-projects')),
  blob_key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generation BIGINT NOT NULL DEFAULT 1,
  UNIQUE (store_name, blob_key)
);

CREATE INDEX IF NOT EXISTS blob_cleanup_queue_retry_idx
  ON blob_cleanup_queue (store_name, next_attempt_at, id);
