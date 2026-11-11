CREATE TABLE writer_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch bigint NOT NULL DEFAULT 0,
  backend_pid integer,
  backend_start timestamptz,
  application_id uuid,
  control_id uuid,
  cleanup_uncertain boolean NOT NULL DEFAULT true
);
INSERT INTO writer_control(singleton) VALUES(true);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  request_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('chat','execution','advisory')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  epoch bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('queued','running','completed','failed','timeout','cancelled','interrupted')),
  started text NOT NULL DEFAULT 'unknown' CHECK (started IN ('unknown','observed','not-started')),
  cleanup text NOT NULL DEFAULT 'unknown' CHECK (cleanup IN ('unknown','verified')),
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor,request_id)
);

CREATE TABLE grants (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('chat','execution','advisory')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_by uuid UNIQUE REFERENCES jobs(id)
);

CREATE TABLE operation_containers (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  application_id uuid NOT NULL,
  control_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id),
  stopped boolean NOT NULL DEFAULT false
);
