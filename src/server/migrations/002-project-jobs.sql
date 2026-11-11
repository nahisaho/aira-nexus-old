ALTER TABLE jobs ADD COLUMN project_id uuid;
ALTER TABLE jobs ADD CONSTRAINT job_project_owner
  FOREIGN KEY(project_id,actor) REFERENCES projects(id,actor);
CREATE INDEX project_active_jobs ON jobs(project_id,actor,state)
  WHERE state IN ('queued','running');
