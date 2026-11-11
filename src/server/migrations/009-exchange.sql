CREATE TABLE notebook_imports (
  notebook_id uuid PRIMARY KEY REFERENCES notebooks(id),
  wire_bytes integer NOT NULL CHECK (wire_bytes BETWEEN 1 AND 12582912),
  original_document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
GRANT SELECT, INSERT ON notebook_imports TO aira_application;
