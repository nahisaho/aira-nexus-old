import pg from "pg";
import { databaseConfig } from "./database";
import type { Credentials } from "./credentials";
import { Operations, type Job } from "./operations";
import { Sessions, type ProjectChat } from "./sessions";
import { ServiceError } from "./http";
import { z } from "zod";
import { validText } from "./chat-context";
import { ownedProject, PROJECT_SELECT } from "./project-scope";

export type ProjectIntent = Omit<Parameters<Operations["admit"]>[0], "actor">;
const revisionSchema = z.number().int().min(1).max(2147483647);
const createSchema = z
  .object({ name: z.string(), description: z.string().default("") })
  .strict();
const editSchema = z
  .object({
    revision: revisionSchema,
    name: z.string().optional(),
    description: z.string().optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.description !== undefined,
  );
function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ServiceError(400, "INVALID_PROJECT_INPUT");
  return parsed.data;
}
function writable(project: ProjectChat, revision: number) {
  if (project.status !== "active")
    throw new ServiceError(409, "PROJECT_ARCHIVED");
  if (project.revision !== revision)
    throw new ServiceError(409, "STALE_PROJECT_REVISION");
  if (project.revision === 2147483647)
    throw new ServiceError(409, "PROJECT_REVISION_EXHAUSTED");
}

/** @id CODE-PROJECT-STORE @implements REQ-PROJECT-001 REQ-PROJECT-002 REQ-PROJECT-003 REQ-PROJECT-005 */
export class Projects {
  private readonly pool: pg.Pool;
  constructor(
    private readonly operations: Operations,
    private readonly sessions: Sessions,
    state: string,
    credentials: Credentials,
  ) {
    this.pool = new pg.Pool({
      ...databaseConfig(state, credentials, "application"),
      max: 4,
    });
    this.pool.on("error", () =>
      console.error("PROJECT_DATABASE_CONNECTION_LOST"),
    );
  }
  async list(actor: string): Promise<ProjectChat[]> {
    return this.listVisibility(actor, false);
  }
  /** @id CODE-PROJECT-ORDER @implements REQ-PROJECT-006 */
  private async listVisibility(
    actor: string,
    hidden: boolean,
  ): Promise<ProjectChat[]> {
    validText(actor, 120);
    const result = await this.pool.query<ProjectChat>(
      `${PROJECT_SELECT} WHERE p.actor=$1 AND (p.hidden_at IS NOT NULL)=$2
      ORDER BY p.last_opened_at DESC NULLS LAST,p.created_at DESC,p.id`,
      [actor, hidden],
    );
    if (result.rows.some((project) => !project.chatId))
      throw new ServiceError(503, "PROJECT_CHAT_INVARIANT_BROKEN");
    return result.rows;
  }
  async get(actor: string, id: string): Promise<ProjectChat> {
    return ownedProject(this.pool, actor, id);
  }
  /** @id CODE-PROJECT-PIN @implements REQ-PROJECT-006 */
  async pin(actor: string, id: string, input: unknown): Promise<ProjectChat> {
    const { pinned } = validated(
      z.object({ pinned: z.boolean() }).strict(),
      input,
    );
    return this.operations.write(async (client) => {
      await ownedProject(client, actor, id, true);
      await client.query("UPDATE projects SET pinned=$1 WHERE id=$2", [
        pinned,
        id,
      ]);
      return ownedProject(client, actor, id);
    });
  }
  /** @id CODE-PROJECT-VISIT @implements REQ-PROJECT-006 */
  async visit(actor: string, id: string, input: unknown): Promise<ProjectChat> {
    validated(z.object({}).strict(), input);
    return this.operations.write(async (client) => {
      await ownedProject(client, actor, id, true);
      await client.query(
        "UPDATE projects SET last_opened_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      return ownedProject(client, actor, id);
    });
  }
  /** @id CODE-VIS-HIDE @implements REQ-VIS-001 REQ-VIS-003 */
  async hide(
    actor: string,
    id: string,
    revision: unknown,
  ): Promise<ProjectChat> {
    return this.visibility(actor, id, revision, true);
  }
  /** @id CODE-VIS-RESTORE @implements REQ-VIS-002 REQ-VIS-003 */
  async restore(
    actor: string,
    id: string,
    revision: unknown,
  ): Promise<ProjectChat> {
    return this.visibility(actor, id, revision, false);
  }
  async deleted(actor: string): Promise<ProjectChat[]> {
    return this.listVisibility(actor, true);
  }
  private async visibility(
    actor: string,
    id: string,
    revision: unknown,
    hidden: boolean,
  ): Promise<ProjectChat> {
    const expected = validated(revisionSchema, revision);
    return this.operations.write(async (client) => {
      const project = await ownedProject(client, actor, id, true, true);
      if (project.revision !== expected)
        throw new ServiceError(409, "STALE_PROJECT_REVISION");
      if (project.revision === 2147483647)
        throw new ServiceError(409, "PROJECT_REVISION_EXHAUSTED");
      const current = await client.query<{ hidden: boolean }>(
        "SELECT hidden_at IS NOT NULL AS hidden FROM projects WHERE id=$1",
        [id],
      );
      if (current.rows[0].hidden === hidden)
        throw new ServiceError(409, "PROJECT_VISIBILITY_CONFLICT");
      if (hidden) {
        const busy = await client.query(
          `SELECT id FROM jobs WHERE project_id=$1 AND actor=$2
          AND purpose IN ('chat','execution') AND state IN ('queued','running') LIMIT 1`,
          [id, actor],
        );
        if (busy.rowCount) throw new ServiceError(409, "PROJECT_BUSY");
      }
      await client.query(
        `UPDATE projects SET hidden_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
        revision=revision+1 WHERE id=$1`,
        [id, hidden],
      );
      return ownedProject(client, actor, id, false, true);
    });
  }
  async create(actor: string, input: unknown): Promise<ProjectChat> {
    const fields = validated(createSchema, input);
    return this.sessions.createProject(actor, fields.name, fields.description);
  }
  async edit(actor: string, id: string, input: unknown): Promise<ProjectChat> {
    const fields = validated(editSchema, input);
    const name =
      fields.name === undefined ? undefined : validText(fields.name, 120, true);
    const description = fields.description;
    if (description !== undefined && description !== "")
      validText(description, 2000);
    return this.operations.write(async (client) => {
      const project = await ownedProject(client, actor, id, true);
      writable(project, fields.revision);
      await client.query(
        "UPDATE projects SET name=$1,description=$2,revision=revision+1 WHERE id=$3",
        [name ?? project.name, description ?? project.description, id],
      );
      return ownedProject(client, actor, id);
    });
  }
  async archive(
    actor: string,
    id: string,
    revision: unknown,
  ): Promise<ProjectChat> {
    const expected = validated(revisionSchema, revision);
    return this.operations.write(async (client) => {
      const project = await ownedProject(client, actor, id, true);
      writable(project, expected);
      const busy = await client.query(
        `SELECT id FROM jobs WHERE project_id=$1 AND actor=$2
        AND purpose IN ('chat','execution') AND state IN ('queued','running') LIMIT 1`,
        [id, actor],
      );
      if (busy.rowCount) throw new ServiceError(409, "PROJECT_BUSY");
      await client.query(
        "UPDATE projects SET status='archived',revision=revision+1 WHERE id=$1",
        [id],
      );
      return ownedProject(client, actor, id);
    });
  }
  async admit(actor: string, id: string, input: ProjectIntent): Promise<Job> {
    return this.operations.admit({ ...input, actor }, id);
  }
  async close() {
    await this.pool.end();
  }
}
