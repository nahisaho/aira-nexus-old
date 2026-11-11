ALTER TABLE jobs DROP CONSTRAINT jobs_purpose_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_purpose_check
  CHECK (purpose IN ('chat','execution','advisory','check'));

CREATE TABLE research_check_requests (
  job_id uuid PRIMARY KEY,
  actor text NOT NULL,
  project_id uuid NOT NULL,
  purpose text NOT NULL DEFAULT 'check' CHECK (purpose='check'),
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  capture jsonb NOT NULL CHECK (jsonb_typeof(capture)='object'),
  UNIQUE(job_id,project_id,actor),
  FOREIGN KEY(job_id,actor,purpose) REFERENCES jobs(id,actor,purpose),
  FOREIGN KEY(project_id,actor) REFERENCES projects(id,actor)
);
CREATE TABLE research_check_reports (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE,
  actor text NOT NULL,
  project_id uuid NOT NULL,
  report jsonb NOT NULL CHECK (jsonb_typeof(report)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(job_id,project_id,actor)
    REFERENCES research_check_requests(job_id,project_id,actor)
);
GRANT SELECT, INSERT ON research_check_requests, research_check_reports TO aira_application;
