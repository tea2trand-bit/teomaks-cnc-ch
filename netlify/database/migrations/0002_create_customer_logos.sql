-- Durable metadata for the customer / reference logos shown in the
-- "Unsere Kunden" section. The image bytes themselves live in Netlify Blobs
-- (object store), keyed by `blob_key`; this table only holds the small,
-- queryable record that drives ordering and visibility.
CREATE TABLE IF NOT EXISTS customer_logos (
  id           SERIAL PRIMARY KEY,
  blob_key     TEXT        NOT NULL,
  content_type TEXT        NOT NULL DEFAULT 'image/png',
  active       BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The public site reads logos ordered by `sort_order`; index it so the
-- ordered read stays cheap as the list grows.
CREATE INDEX IF NOT EXISTS customer_logos_sort_idx ON customer_logos (sort_order, id);
