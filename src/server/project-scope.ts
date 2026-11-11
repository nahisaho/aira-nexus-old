import type pg from "pg";
import { z } from "zod";
import { ServiceError } from "./http";
import { validText } from "./chat-context";
import type { ProjectChat } from "./sessions";

export const PROJECT_SELECT = `SELECT p.id,p.actor,p.name,p.description,p.revision,p.status,
  p.pinned,p.last_opened_at::text AS "lastOpenedAt",
  c.id AS "chatId",c.title AS "chatTitle",c.revision AS "chatRevision"
  FROM projects p LEFT JOIN chats c ON c.id=p.chat_id AND c.project_id=p.id AND c.actor=p.actor`;

export function projectId(value: string) {
  if (!z.uuid().safeParse(value).success)
    throw new ServiceError(400, "INVALID_ID");
}
/** @id CODE-PROJECT-SCOPE @implements REQ-PROJECT-003 REQ-PROJECT-005 REQ-SESSION-001 REQ-VIS-001 REQ-VIS-003 */
export async function ownedProject(
  client: pg.Client | pg.Pool,
  actor: string,
  id: string,
  lock = false,
  includeHidden = false,
): Promise<ProjectChat> {
  projectId(id);
  validText(actor, 120);
  const result = await client.query<ProjectChat>(
    `${PROJECT_SELECT} WHERE p.id=$1 AND p.actor=$2 ${includeHidden ? "" : "AND p.hidden_at IS NULL"} ${lock ? "FOR UPDATE OF p" : ""}`,
    [id, actor],
  );
  if (result.rowCount !== 1) throw new ServiceError(404, "PROJECT_NOT_FOUND");
  if (!result.rows[0].chatId)
    throw new ServiceError(503, "PROJECT_CHAT_INVARIANT_BROKEN");
  return result.rows[0];
}
