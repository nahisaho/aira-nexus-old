CREATE TABLE file_versions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  actor text NOT NULL,
  name text NOT NULL,
  mime text NOT NULL,
  size bigint NOT NULL CHECK (size BETWEEN 0 AND 104857600),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  blob_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(project_id,actor) REFERENCES projects(id,actor)
);
CREATE INDEX project_files ON file_versions(project_id,created_at,id);
CREATE TABLE file_reservations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  actor text NOT NULL,
  epoch bigint NOT NULL,
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes BETWEEN 0 AND 104857600),
  FOREIGN KEY(project_id,actor) REFERENCES projects(id,actor)
);
GRANT SELECT, INSERT ON file_versions TO aira_application;
GRANT SELECT, INSERT, UPDATE, DELETE ON file_reservations TO aira_application;
