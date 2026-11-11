ALTER TABLE projects ADD COLUMN hidden_at timestamptz;
GRANT UPDATE(hidden_at) ON projects TO aira_application;
