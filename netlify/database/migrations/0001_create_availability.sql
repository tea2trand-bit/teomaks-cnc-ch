-- Durable storage for the availability calendar.
-- One row per booked day, stored as a YYYY-MM-DD string so it matches the
-- exact keys the calendar uses on the front end (no timezone conversion).
CREATE TABLE IF NOT EXISTS availability (
  booked_date TEXT PRIMARY KEY
);

-- Seed with the dates the site shipped with so nothing is lost on first deploy.
INSERT INTO availability (booked_date) VALUES
  ('2026-09-21'),
  ('2026-09-22'),
  ('2026-10-06'),
  ('2026-10-07'),
  ('2026-11-12')
ON CONFLICT (booked_date) DO NOTHING;
