-- @id CODE-NOTE-LABNOTE-MIGRATION @implements REQ-NOTE-004 REQ-NOTE-005 REQ-NOTE-006
DO $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(918273645) THEN
    RAISE EXCEPTION 'PROJECT_LAB_NOTE_REQUIRES_QUIESCENT_WRITER';
  END IF;
END $$;

CREATE TABLE project_lab_notes (
  project_id uuid PRIMARY KEY REFERENCES projects(id),
  notebook_id uuid NOT NULL UNIQUE REFERENCES notebooks(id),
  actor text NOT NULL,
  FOREIGN KEY(notebook_id,project_id,actor)
    REFERENCES notebook_links(id,project_id,actor)
);
GRANT SELECT ON project_lab_notes TO aira_application;

CREATE FUNCTION project_lab_note_markdown(body jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(body->'cells')='array'
    THEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(body->'cells') AS cell
      WHERE cell->>'cell_type' IS DISTINCT FROM 'markdown')
    ELSE false END
$$;
CREATE FUNCTION guard_project_lab_note_document() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE note_id uuid; body jsonb;
BEGIN
  IF TG_TABLE_NAME='notebooks' THEN
    note_id := NEW.id; body := NEW.document;
  ELSE
    note_id := NEW.notebook_id; body := NEW.content->'document';
  END IF;
  IF EXISTS(SELECT 1 FROM public.project_lab_notes WHERE notebook_id=note_id)
    AND NOT public.project_lab_note_markdown(body) THEN
    RAISE EXCEPTION 'PROJECT_LAB_NOTE_MARKDOWN_ONLY' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_project_lab_note_document() FROM PUBLIC;
CREATE TRIGGER project_lab_note_document BEFORE INSERT OR UPDATE ON notebooks
  FOR EACH ROW EXECUTE FUNCTION guard_project_lab_note_document();
CREATE TRIGGER project_lab_note_version BEFORE INSERT OR UPDATE ON notebook_versions
  FOR EACH ROW EXECUTE FUNCTION guard_project_lab_note_document();

CREATE FUNCTION provision_project_lab_note(p_project uuid,p_actor text,p_chat uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  note_id uuid := gen_random_uuid();
  body jsonb;
  saved jsonb;
  version_id bigint;
BEGIN
  PERFORM 1 FROM public.projects p JOIN public.chats c ON c.id=p.chat_id
    WHERE p.id=p_project AND p.actor=p_actor AND c.id=p_chat
      AND c.project_id=p_project AND c.actor=p_actor FOR UPDATE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_LAB_NOTE_ASSOCIATION_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM public.project_lab_notes WHERE project_id=p_project)
    THEN RETURN; END IF;
  body := jsonb_build_object('nbformat',4,'nbformat_minor',5,
    'metadata',jsonb_build_object('aira',jsonb_build_object(
      'project_id',p_project,'chat_id',p_chat,'notebook_id',note_id)),
    'cells','[]'::jsonb);
  INSERT INTO public.notebook_links(id,actor,project_id,chat_id)
    VALUES(note_id,p_actor,p_project,p_chat);
  INSERT INTO public.notebooks(id,name,document) VALUES(note_id,'Lab Note',body);
  INSERT INTO public.project_lab_notes VALUES(p_project,note_id,p_actor);
  saved := jsonb_build_object('name','Lab Note','document',body);
  INSERT INTO public.notebook_versions(notebook_id,project_id,actor,revision,
    content,sha256,origin,editor)
    VALUES(note_id,p_project,p_actor,1,saved,
      encode(sha256(convert_to(saved::text,'UTF8')),'hex'),'create',NULL)
    RETURNING id INTO version_id;
  INSERT INTO public.notebook_git_projects(project_id)
    VALUES(p_project) ON CONFLICT DO NOTHING;
  INSERT INTO public.notebook_git_exports(version_id,project_id)
    VALUES(version_id,p_project);
END $$;
REVOKE ALL ON FUNCTION provision_project_lab_note(uuid,text,uuid) FROM PUBLIC;

CREATE FUNCTION project_lab_note_after_chat() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM public.provision_project_lab_note(NEW.project_id,NEW.actor,NEW.id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION project_lab_note_after_chat() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER project_lab_note_created AFTER INSERT ON chats
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION project_lab_note_after_chat();
SELECT provision_project_lab_note(project_id,actor,id)
  FROM chats ORDER BY project_id;
