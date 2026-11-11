CREATE TABLE proposal_changes (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  chat_id uuid NOT NULL REFERENCES chats(id),
  action jsonb NOT NULL,
  before_value jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','rejected')),
  accepted_revision integer CHECK (accepted_revision >= 0),
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state='accepted' AND receipt IS NOT NULL AND accepted_revision IS NOT NULL)
     OR (state<>'accepted' AND receipt IS NULL AND accepted_revision IS NULL))
);

CREATE TABLE runtime_reservations (
  notebook_id uuid PRIMARY KEY REFERENCES notebooks(id),
  kernel_epoch uuid NOT NULL,
  image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
  writer_epoch bigint NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','starting','ready','closing','uncertain'))
);

CREATE TABLE confirmations (
  id uuid PRIMARY KEY,
  actor text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  chat_id uuid NOT NULL REFERENCES chats(id),
  kind text NOT NULL CHECK (kind IN ('execution','disclosure')),
  grant_id uuid NOT NULL UNIQUE REFERENCES grants(id),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (snapshot->>'kind'=kind AND snapshot->>'actor'=actor
    AND snapshot->>'projectId'=project_id::text AND snapshot->>'chatId'=chat_id::text)
);

CREATE TABLE confirmed_receipts (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  confirmation_id uuid NOT NULL UNIQUE REFERENCES confirmations(id),
  receipt jsonb NOT NULL,
  CHECK (receipt->>'jobId'=job_id::text AND receipt->>'confirmationId'=confirmation_id::text)
);
GRANT SELECT, INSERT ON proposal_changes, runtime_reservations, confirmations, confirmed_receipts TO aira_application;
GRANT UPDATE(state,accepted_revision,receipt) ON proposal_changes TO aira_application;
GRANT UPDATE(kernel_epoch,image_digest,writer_epoch,state) ON runtime_reservations TO aira_application;
GRANT UPDATE(revoked) ON confirmations TO aira_application;
