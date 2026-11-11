CREATE TABLE project_integration_settings (
  project_id uuid PRIMARY KEY,
  actor text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  selections jsonb NOT NULL CHECK (jsonb_typeof(selections)='object'),
  FOREIGN KEY(project_id,actor) REFERENCES projects(id,actor)
);
GRANT SELECT, INSERT ON project_integration_settings TO aira_application;
GRANT UPDATE(revision,selections) ON project_integration_settings TO aira_application;
