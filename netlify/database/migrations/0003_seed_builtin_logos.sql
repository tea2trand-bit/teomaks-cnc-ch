-- Bring the two logos that previously lived ONLY as static markup in the
-- "Unsere Kunden" section (Starrag, Trikno) into the managed collection, so
-- they are listed, ordered, toggled and never silently replaced when a new
-- logo is uploaded through the admin.
--
-- These seed rows reference the bundled static asset directly (asset_url)
-- instead of a Netlify Blob: a migration cannot write image bytes into the
-- object store, and the originals already ship in /assets. `blob_key` is
-- therefore made optional, and a row carries EITHER a blob_key (uploaded /
-- replaced image) OR an asset_url (built-in image).
ALTER TABLE customer_logos ADD COLUMN IF NOT EXISTS asset_url TEXT;
ALTER TABLE customer_logos ALTER COLUMN blob_key DROP NOT NULL;

-- Seed the built-in logos once. Guarded so re-runs (or a branch that already
-- has them) never create duplicates.
INSERT INTO customer_logos (blob_key, asset_url, content_type, active, sort_order)
SELECT NULL, '/assets/customer-starrag.png', 'image/png', TRUE, 1
WHERE NOT EXISTS (
  SELECT 1 FROM customer_logos WHERE asset_url = '/assets/customer-starrag.png'
);

INSERT INTO customer_logos (blob_key, asset_url, content_type, active, sort_order)
SELECT NULL, '/assets/customer-trikno.png', 'image/png', TRUE, 2
WHERE NOT EXISTS (
  SELECT 1 FROM customer_logos WHERE asset_url = '/assets/customer-trikno.png'
);
