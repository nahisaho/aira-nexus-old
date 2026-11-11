CREATE TABLE notebook_links (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  actor text NOT NULL,
  UNIQUE(id,project_id,actor),
  FOREIGN KEY(chat_id,project_id,actor) REFERENCES chats(id,project_id,actor)
);
ALTER TABLE jobs ADD COLUMN dispatched_at timestamptz;
ALTER TABLE jobs ADD COLUMN started_at timestamptz;
ALTER TABLE jobs ADD COLUMN ended_at timestamptz;
CREATE FUNCTION observe_job_times() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state='queued' AND NEW.state='running' THEN
    NEW.dispatched_at=clock_timestamp();
  END IF;
  IF OLD.started<>'observed' AND NEW.started='observed' THEN
    NEW.started_at=clock_timestamp();
  END IF;
  IF OLD.state IN ('queued','running') AND NEW.state NOT IN ('queued','running') THEN
    NEW.ended_at=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_observed_times BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION observe_job_times();
CREATE TABLE runs (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  actor text NOT NULL,
  project_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  notebook_id uuid NOT NULL,
  cell_id text NOT NULL CHECK (cell_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  job_id uuid NOT NULL UNIQUE,
  purpose text NOT NULL DEFAULT 'execution' CHECK (purpose='execution'),
  revision integer NOT NULL CHECK (revision>0),
  source text NOT NULL CHECK (octet_length(source)<=65536),
  language text NOT NULL CHECK (language IN ('python','r')),
  sharing jsonb NOT NULL,
  inputs jsonb NOT NULL,
  environment jsonb,
  kernel_epoch uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,notebook_id,project_id,actor),
  FOREIGN KEY(notebook_id,project_id,actor) REFERENCES notebook_links(id,project_id,actor),
  FOREIGN KEY(chat_id,project_id,actor) REFERENCES chats(id,project_id,actor),
  FOREIGN KEY(job_id,actor,purpose) REFERENCES jobs(id,actor,purpose)
);
CREATE INDEX notebook_run_history ON runs(notebook_id,sequence DESC);
CREATE TABLE run_results (
  run_id uuid PRIMARY KEY REFERENCES runs(id),
  outputs jsonb NOT NULL,
  output_bytes integer NOT NULL CHECK (output_bytes BETWEEN 0 AND 2097152),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE chat_turns ADD CONSTRAINT turn_owned_id UNIQUE(id,project_id,actor);
ALTER TABLE file_versions ADD COLUMN origin_kind text NOT NULL DEFAULT 'unavailable'
  CHECK (origin_kind IN ('unavailable','upload','run','turn'));
ALTER TABLE file_versions ADD COLUMN chat_id uuid;
ALTER TABLE file_versions ADD COLUMN notebook_id uuid;
ALTER TABLE file_versions ADD COLUMN run_id uuid;
ALTER TABLE file_versions ADD COLUMN turn_id uuid;
ALTER TABLE file_versions ADD CONSTRAINT file_origin_shape CHECK (
  (origin_kind='unavailable' AND chat_id IS NULL AND notebook_id IS NULL AND run_id IS NULL AND turn_id IS NULL) OR
  (origin_kind='upload' AND chat_id IS NOT NULL AND notebook_id IS NULL AND run_id IS NULL AND turn_id IS NULL) OR
  (origin_kind='run' AND chat_id IS NOT NULL AND notebook_id IS NOT NULL AND run_id IS NOT NULL AND turn_id IS NULL) OR
  (origin_kind='turn' AND chat_id IS NOT NULL AND notebook_id IS NULL AND run_id IS NULL AND turn_id IS NOT NULL)
);
ALTER TABLE file_versions ADD CONSTRAINT file_origin_chat
  FOREIGN KEY(chat_id,project_id,actor) REFERENCES chats(id,project_id,actor);
ALTER TABLE file_versions ADD CONSTRAINT file_origin_notebook
  FOREIGN KEY(notebook_id,project_id,actor) REFERENCES notebook_links(id,project_id,actor);
ALTER TABLE file_versions ADD CONSTRAINT file_origin_run
  FOREIGN KEY(run_id,notebook_id,project_id,actor) REFERENCES runs(id,notebook_id,project_id,actor);
ALTER TABLE file_versions ADD CONSTRAINT file_origin_turn
  FOREIGN KEY(turn_id,project_id,actor) REFERENCES chat_turns(id,project_id,actor);
GRANT SELECT, INSERT ON notebook_links, runs, run_results TO aira_application;
GRANT USAGE ON SEQUENCE runs_sequence_seq TO aira_application;
