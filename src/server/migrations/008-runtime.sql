CREATE TABLE runtime_containers (
  kernel_epoch uuid PRIMARY KEY,
  notebook_id uuid NOT NULL REFERENCES notebooks(id),
  actor text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  application_id uuid NOT NULL,
  control_id uuid NOT NULL,
  image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
  container_id text UNIQUE CHECK (container_id ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('creating','ready','stopped','uncertain')),
  inputs jsonb NOT NULL,
  environment jsonb,
  writer_epoch bigint NOT NULL,
  last_used timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE runtime_job_bindings (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  kernel_epoch uuid NOT NULL REFERENCES runtime_containers(kernel_epoch)
);
CREATE TABLE runtime_outcomes (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  run_id uuid REFERENCES runs(id),
  status integer NOT NULL CHECK (status BETWEEN 200 AND 599),
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,119}$')
);
GRANT SELECT, INSERT ON runtime_containers, runtime_job_bindings, runtime_outcomes TO aira_application;
GRANT UPDATE(container_id,state,environment,last_used) ON runtime_containers TO aira_application;
