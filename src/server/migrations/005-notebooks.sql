CREATE TABLE notebooks (
  id uuid PRIMARY KEY REFERENCES notebook_links(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE runs ADD CONSTRAINT run_cell_identity UNIQUE(id,notebook_id,cell_id);
CREATE TABLE notebook_cell_results (
  notebook_id uuid NOT NULL REFERENCES notebooks(id),
  cell_id text NOT NULL,
  run_id uuid NOT NULL UNIQUE,
  PRIMARY KEY(notebook_id,cell_id),
  FOREIGN KEY(run_id,notebook_id,cell_id) REFERENCES runs(id,notebook_id,cell_id)
);
GRANT SELECT, INSERT ON notebooks, notebook_cell_results TO aira_application;
GRANT UPDATE(name,revision,document) ON notebooks TO aira_application;
GRANT UPDATE(run_id) ON notebook_cell_results TO aira_application;
