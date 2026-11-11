import pg from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { databaseConfig } from "./database";
import type { Credentials } from "./credentials";
import { Operations } from "./operations";
import { ServiceError } from "./http";
import { ownedProject } from "./project-scope";
import {
  buildContext,
  validText,
  encodedJson,
  MAX_HISTORY_CHARACTERS,
  type ChatHistory,
  type ExcerptResolver,
  type ExcerptSelection,
} from "./chat-context";
import {
  streamEvents,
  MAX_EVENT_BYTES,
  MAX_TURN_EVENTS,
  MAX_TURN_EVENT_BYTES,
  type StoredEvent,
  type TurnEvent,
  type TurnProjection,
  type StreamOptions,
} from "./sse";

export interface ProjectChat {
  id: string;
  actor: string;
  name: string;
  description: string;
  revision: number;
  status: "active" | "archived";
  pinned: boolean;
  lastOpenedAt: string | null;
  chatId: string;
  chatTitle: string;
  chatRevision: number;
}
const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("partial"), text: z.string() }).strict(),
  z.object({ kind: z.enum(["tool", "proposal"]), payload: z.json() }).strict(),
]);
function uuid(value: string) {
  if (!z.uuid().safeParse(value).success)
    throw new ServiceError(400, "INVALID_ID");
}

/** @id CODE-SESSION-STORE @implements REQ-SESSION-001 REQ-SESSION-002 REQ-SESSION-003 */
export class Sessions {
  private readonly pool: pg.Pool;
  constructor(
    private readonly operations: Operations,
    state: string,
    credentials: Credentials,
    private readonly resolver?: ExcerptResolver,
  ) {
    this.pool = new pg.Pool({
      ...databaseConfig(state, credentials, "application"),
      max: 4,
    });
    this.pool.on("error", () => {
      console.error("SESSION_DATABASE_CONNECTION_LOST");
    });
  }
  private async owned(
    client: pg.Client | pg.Pool,
    actor: string,
    projectId: string,
    lock = false,
  ): Promise<ProjectChat> {
    return ownedProject(client, actor, projectId, lock);
  }
  private active(project: ProjectChat) {
    if (project.status !== "active")
      throw new ServiceError(409, "PROJECT_ARCHIVED");
  }
  async createProject(
    actor: string,
    name: string,
    description = "",
  ): Promise<ProjectChat> {
    validText(actor, 120);
    name = validText(name, 120, true);
    if (description !== "") validText(description, 2000);
    return this.operations.write(async (client) => {
      const id = randomUUID(),
        chatId = randomUUID();
      await client.query(
        "INSERT INTO projects(id,actor,chat_id,name,description) VALUES($1,$2,$3,$4,$5)",
        [id, actor, chatId, name, description],
      );
      await client.query(
        "INSERT INTO chats(id,project_id,actor) VALUES($1,$2,$3)",
        [chatId, id, actor],
      );
      return this.owned(client, actor, id);
    });
  }
  async open(actor: string, projectId: string): Promise<ProjectChat> {
    return this.owned(this.pool, actor, projectId);
  }
  async rename(
    actor: string,
    projectId: string,
    title: string,
  ): Promise<ProjectChat> {
    title = validText(title, 120, true);
    return this.operations.write(async (client) => {
      const project = await this.owned(client, actor, projectId, true);
      this.active(project);
      await client.query(
        "UPDATE chats SET title=$1,revision=revision+1 WHERE id=$2",
        [title, project.chatId],
      );
      return this.owned(client, actor, projectId);
    });
  }
  async openTurn(
    actor: string,
    projectId: string,
    jobId: string,
    prompt: string,
  ): Promise<string> {
    uuid(jobId);
    validText(prompt, 16000);
    return this.operations.write(async (client) => {
      const project = await this.owned(client, actor, projectId, true);
      const existing = await client.query<{
        id: string;
        project_id: string;
        prompt: string;
      }>(
        "SELECT id,project_id,prompt FROM chat_turns WHERE job_id=$1 AND actor=$2",
        [jobId, actor],
      );
      if (existing.rowCount) {
        const row = existing.rows[0];
        if (row.project_id !== projectId || row.prompt !== prompt)
          throw new ServiceError(409, "TURN_INTENT_CONFLICT");
        return row.id;
      }
      this.active(project);
      const job = await client.query(
        `SELECT id FROM jobs WHERE id=$1 AND actor=$2 AND purpose='chat'
        AND state='queued' AND NOT cancel_requested AND epoch=(SELECT epoch FROM writer_control)
        AND (project_id IS NULL OR project_id=$3)`,
        [jobId, actor, projectId],
      );
      if (job.rowCount !== 1)
        throw new ServiceError(409, "CHAT_JOB_NOT_ADMISSIBLE");
      const id = randomUUID();
      await client.query("UPDATE jobs SET project_id=$1 WHERE id=$2", [
        projectId,
        jobId,
      ]);
      await client.query(
        `INSERT INTO chat_turns(id,project_id,chat_id,actor,job_id,prompt)
        VALUES($1,$2,$3,$4,$5,$6)`,
        [id, projectId, project.chatId, actor, jobId, prompt],
      );
      return id;
    });
  }
  async recordEvent(
    actor: string,
    projectId: string,
    turnId: string,
    event: TurnEvent,
  ): Promise<void> {
    uuid(turnId);
    let parsed: z.infer<typeof eventSchema>;
    try {
      parsed = eventSchema.parse(event);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof RangeError)
        throw new ServiceError(400, "INVALID_CHAT_EVENT");
      throw error;
    }
    const encoded = encodedJson(
      parsed,
      MAX_EVENT_BYTES,
      "INVALID_CHAT_EVENT",
      "CHAT_EVENT_TOO_LARGE",
    );
    const size = Buffer.byteLength(encoded);
    return this.operations.write(async (client) => {
      this.active(await this.owned(client, actor, projectId, true));
      const result = await client.query<{
        event_count: number;
        event_bytes: number;
        state: string;
        epoch: string;
        current: string;
      }>(
        `SELECT t.event_count,t.event_bytes,j.state,j.epoch,w.epoch AS current
        FROM chat_turns t JOIN jobs j ON j.id=t.job_id CROSS JOIN writer_control w
        WHERE t.id=$1 AND t.actor=$2 AND t.project_id=$3 FOR UPDATE OF t`,
        [turnId, actor, projectId],
      );
      if (result.rowCount !== 1) throw new ServiceError(404, "TURN_NOT_FOUND");
      const row = result.rows[0];
      if (row.state !== "running" || row.epoch !== row.current)
        throw new ServiceError(409, "TURN_NOT_RUNNING");
      if (
        row.event_count >= MAX_TURN_EVENTS ||
        row.event_bytes + size > MAX_TURN_EVENT_BYTES
      ) {
        throw new ServiceError(413, "CHAT_TURN_BUDGET_EXCEEDED");
      }
      const sequence = row.event_count + 1;
      await client.query(
        `UPDATE chat_turns SET response=response || $1,event_count=$2,event_bytes=event_bytes+$3 WHERE id=$4`,
        [parsed.kind === "partial" ? parsed.text : "", sequence, size, turnId],
      );
      await client.query(
        "INSERT INTO chat_events(turn_id,sequence,kind,payload) VALUES($1,$2,$3,$4::jsonb)",
        [
          turnId,
          sequence,
          parsed.kind,
          JSON.stringify(
            parsed.kind === "partial" ? { text: parsed.text } : parsed.payload,
          ),
        ],
      );
    });
  }
  async turn(
    actor: string,
    projectId: string,
    turnId: string,
    after = 0,
  ): Promise<TurnProjection> {
    uuid(turnId);
    if (!Number.isSafeInteger(after) || after < 0 || after > MAX_TURN_EVENTS)
      throw new ServiceError(400, "INVALID_EVENT_CURSOR");
    await this.open(actor, projectId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await client.query<{
        id: string;
        jobId: string;
        state: TurnProjection["state"];
        response: string;
        lastSequence: number;
      }>(
        `SELECT t.id,t.job_id AS "jobId",j.state,t.response,t.event_count AS "lastSequence"
        FROM chat_turns t JOIN jobs j ON j.id=t.job_id
        WHERE t.id=$1 AND t.project_id=$2 AND t.actor=$3`,
        [turnId, projectId, actor],
      );
      if (result.rowCount !== 1) throw new ServiceError(404, "TURN_NOT_FOUND");
      const row = result.rows[0];
      if (after > row.lastSequence)
        throw new ServiceError(409, "EVENT_CURSOR_AHEAD");
      const events = await client.query<StoredEvent>(
        "SELECT sequence,kind,payload FROM chat_events WHERE turn_id=$1 AND sequence>$2 ORDER BY sequence",
        [turnId, after],
      );
      await client.query("COMMIT");
      return { ...row, events: events.rows };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async events(
    actor: string,
    projectId: string,
    turnId: string,
    options: StreamOptions = {},
  ) {
    return streamEvents(
      (after) => this.turn(actor, projectId, turnId, after),
      await this.turn(actor, projectId, turnId, options.after ?? 0),
      options,
    );
  }
  async history(actor: string, projectId: string): Promise<ChatHistory> {
    const project = await this.open(actor, projectId);
    const result = await this.pool.query<ChatHistory>(
      `WITH owned AS (
      SELECT t.id,t.sequence,t.prompt,t.response,j.state FROM chat_turns t JOIN jobs j ON j.id=t.job_id
      WHERE t.project_id=$1 AND t.chat_id=$2 AND t.actor=$3
    ), complete AS (SELECT * FROM owned WHERE state='completed'),
    ranked AS (SELECT *,sum(char_length(prompt)+char_length(response)) OVER(
      ORDER BY sequence DESC ROWS UNBOUNDED PRECEDING) AS used FROM complete),
    selected AS (SELECT * FROM ranked WHERE used <= $4)
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'prompt',prompt,'response',response)
      ORDER BY sequence) FILTER(WHERE id IS NOT NULL),'[]'::jsonb) AS turns,
      ((SELECT count(*) FROM complete)-count(id))::integer AS "omittedComplete",
      (SELECT count(*)::integer FROM owned WHERE state<>'completed') AS "omittedIncomplete"
    FROM selected`,
      [projectId, project.chatId, actor, MAX_HISTORY_CHARACTERS],
    );
    return result.rows[0];
  }
  async previewContext(
    actor: string,
    projectId: string,
    prompt: string,
    selections: ExcerptSelection[] = [],
  ) {
    const project = await this.open(actor, projectId);
    if (project.status !== "active")
      throw new ServiceError(409, "PROJECT_ARCHIVED");
    return buildContext(
      actor,
      projectId,
      project.chatId,
      prompt,
      await this.history(actor, projectId),
      selections,
      this.resolver,
    );
  }
  async authorizedContext(
    actor: string,
    projectId: string,
    prompt: string,
    selections: ExcerptSelection[],
    grantId: string,
  ) {
    uuid(grantId);
    const context = await this.previewContext(
      actor,
      projectId,
      prompt,
      selections,
    );
    const result = await this.pool.query(
      `SELECT id FROM grants WHERE id=$1 AND actor=$2
      AND purpose='chat' AND fingerprint=$3 AND consumed_by IS NULL AND expires_at>clock_timestamp()`,
      [grantId, actor, context.fingerprint],
    );
    if (result.rowCount !== 1)
      throw new ServiceError(409, "CONTEXT_CONFIRMATION_REQUIRED");
    return context;
  }
  async close() {
    await this.pool.end();
  }
}
