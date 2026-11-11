-- @id CODE-NH-MIGRATION @implements REQ-NH-001 REQ-NH-002 REQ-NH-006
DO $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(918273645) THEN
    RAISE EXCEPTION 'NOTEBOOK_HISTORY_REQUIRES_QUIESCENT_WRITER';
  END IF;
END $$;

CREATE FUNCTION notebook_source_document(body jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_set(body,'{cells}',COALESCE(
    (SELECT jsonb_agg(
      CASE WHEN cell->>'cell_type'='code'
        THEN cell || '{"outputs":[],"execution_count":null}'::jsonb
        ELSE cell END ORDER BY position)
    FROM jsonb_array_elements(body->'cells') WITH ORDINALITY AS cells(cell,position)),
    '[]'::jsonb))
$$;

CREATE TABLE notebook_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notebook_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor text NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  content jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  origin text NOT NULL CHECK (origin IN ('create','import','baseline','save','patch','proposal','restore')),
  editor text CHECK (editor IS NULL OR char_length(btrim(editor)) BETWEEN 1 AND 80),
  reason text CHECK (reason IS NULL OR char_length(reason)<=2000),
  proposal_id uuid REFERENCES proposal_changes(id),
  restored_from integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(notebook_id,revision),
  UNIQUE(id,project_id),
  FOREIGN KEY(notebook_id,project_id,actor) REFERENCES notebook_links(id,project_id,actor),
  FOREIGN KEY(notebook_id,restored_from) REFERENCES notebook_versions(notebook_id,revision)
);
CREATE INDEX notebook_versions_page ON notebook_versions(notebook_id,id DESC);

CREATE TABLE notebook_git_projects (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  rebuilt boolean NOT NULL DEFAULT false
);
CREATE TABLE notebook_git_generations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  application_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  rebuilt boolean NOT NULL,
  parent_generation uuid REFERENCES notebook_git_generations(id),
  head text CHECK (head IS NULL OR head ~ '^[a-f0-9]{40,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,project_id)
);
CREATE UNIQUE INDEX notebook_git_current_generation
  ON notebook_git_generations(project_id) WHERE active;
CREATE TABLE notebook_git_exports (
  version_id bigint PRIMARY KEY,
  project_id uuid NOT NULL,
  generation_id uuid,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','exported','error','blocked')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  error_code text,
  commit text,
  expected_parent text,
  prepared_parent text,
  prepared_tree text,
  prepared_commit text,
  next_attempt_ms bigint NOT NULL DEFAULT 0,
  FOREIGN KEY(version_id,project_id) REFERENCES notebook_versions(id,project_id),
  FOREIGN KEY(generation_id,project_id) REFERENCES notebook_git_generations(id,project_id),
  CHECK (state<>'exported' OR (generation_id IS NOT NULL AND commit IS NOT NULL))
);
CREATE INDEX notebook_git_pending ON notebook_git_exports(project_id,version_id)
  WHERE state<>'exported';
CREATE TABLE notebook_git_receipts (
  generation_id uuid NOT NULL REFERENCES notebook_git_generations(id),
  version_id bigint NOT NULL REFERENCES notebook_versions(id),
  parent text,
  tree text NOT NULL,
  commit text NOT NULL,
  PRIMARY KEY(generation_id,version_id)
);

INSERT INTO notebook_versions(notebook_id,project_id,actor,revision,content,sha256,origin)
SELECT id,project_id,actor,revision,content,
  encode(sha256(convert_to(content::text,'UTF8')),'hex'),'baseline'
FROM (
  SELECT n.id,l.project_id,l.actor,n.revision,
    jsonb_build_object('name',n.name,'document',notebook_source_document(n.document)) AS content
  FROM notebooks n JOIN notebook_links l USING(id)
) baselines ORDER BY id
ON CONFLICT(notebook_id,revision) DO NOTHING;
INSERT INTO notebook_git_projects(project_id)
SELECT DISTINCT project_id FROM notebook_versions ON CONFLICT DO NOTHING;
INSERT INTO notebook_git_exports(version_id,project_id)
SELECT id,project_id FROM notebook_versions ORDER BY id ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT ON notebook_versions TO aira_application;
GRANT USAGE ON SEQUENCE notebook_versions_id_seq TO aira_application;
GRANT SELECT, INSERT, UPDATE ON notebook_git_projects, notebook_git_generations,
  notebook_git_exports TO aira_application;
GRANT SELECT, INSERT ON notebook_git_receipts TO aira_application;
