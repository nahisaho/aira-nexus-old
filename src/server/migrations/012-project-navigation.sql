ALTER TABLE projects
  ADD COLUMN pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN last_opened_at timestamptz;

GRANT UPDATE(pinned,last_opened_at) ON projects TO aira_application;
