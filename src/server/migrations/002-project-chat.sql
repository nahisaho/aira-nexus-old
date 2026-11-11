CREATE TABLE projects (
  id uuid PRIMARY KEY,
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 120),
  chat_id uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  UNIQUE(id,actor)
);

CREATE TABLE chats (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL UNIQUE,
  actor text NOT NULL,
  title text NOT NULL DEFAULT 'チャット' CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE(id,project_id,actor),
  FOREIGN KEY(project_id,actor) REFERENCES projects(id,actor) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE projects ADD CONSTRAINT project_exact_chat
  FOREIGN KEY(chat_id,id,actor) REFERENCES chats(id,project_id,actor) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE jobs ADD CONSTRAINT job_actor_purpose UNIQUE(id,actor,purpose);
CREATE TABLE chat_turns (
  id uuid PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  project_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  actor text NOT NULL,
  job_id uuid NOT NULL UNIQUE,
  purpose text NOT NULL DEFAULT 'chat' CHECK (purpose='chat'),
  prompt text NOT NULL CHECK (char_length(prompt) BETWEEN 1 AND 16000),
  response text NOT NULL DEFAULT '',
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count BETWEEN 0 AND 256),
  event_bytes integer NOT NULL DEFAULT 0 CHECK (event_bytes BETWEEN 0 AND 2097152),
  FOREIGN KEY(chat_id,project_id,actor) REFERENCES chats(id,project_id,actor),
  FOREIGN KEY(job_id,actor,purpose) REFERENCES jobs(id,actor,purpose)
);
CREATE INDEX chat_turn_history ON chat_turns(chat_id,sequence DESC);

CREATE TABLE chat_events (
  turn_id uuid NOT NULL REFERENCES chat_turns(id),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 256),
  kind text NOT NULL CHECK (kind IN ('partial','tool','proposal')),
  payload jsonb NOT NULL,
  PRIMARY KEY(turn_id,sequence)
);

GRANT SELECT, INSERT ON projects, chats, chat_turns, chat_events TO aira_application;
GRANT UPDATE(name,description,revision,status) ON projects TO aira_application;
GRANT UPDATE(title,revision) ON chats TO aira_application;
GRANT UPDATE(response,event_count,event_bytes) ON chat_turns TO aira_application;
GRANT USAGE ON SEQUENCE chat_turns_sequence_seq TO aira_application;
