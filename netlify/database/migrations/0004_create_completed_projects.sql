CREATE TABLE IF NOT EXISTS completed_projects (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  project_date TEXT,
  location TEXT,
  customer TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS completed_project_images (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES completed_projects(id) ON DELETE CASCADE,
  blob_key TEXT,
  asset_url TEXT,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  alt_text TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS completed_projects_sort_idx ON completed_projects (sort_order, id);
CREATE INDEX IF NOT EXISTS completed_project_images_project_sort_idx ON completed_project_images (project_id, sort_order, id);

INSERT INTO completed_projects (title, summary, description, active, sort_order)
SELECT
  'CNC Produktionssupport',
  'Präzisionsmessung und technische Kontrolle für maximale Anlagenverfügbarkeit.',
  'Präzisionsmessung und technische Kontrolle für maximale Anlagenverfügbarkeit.',
  TRUE,
  1
WHERE NOT EXISTS (
  SELECT 1 FROM completed_projects WHERE title = 'CNC Produktionssupport'
);

INSERT INTO completed_project_images (project_id, asset_url, content_type, alt_text, sort_order)
SELECT
  p.id,
  '/assets/project-cnc-messtechnik.jpeg',
  'image/jpeg',
  'CNC Maschine ohne Personen',
  1
FROM completed_projects p
WHERE p.title = 'CNC Produktionssupport'
  AND NOT EXISTS (
    SELECT 1 FROM completed_project_images i
    WHERE i.project_id = p.id
      AND i.asset_url = '/assets/project-cnc-messtechnik.jpeg'
  );
