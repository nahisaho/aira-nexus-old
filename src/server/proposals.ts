import pg from "pg";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Operations } from "./operations";
import type { Notebooks, NotebookDocument } from "./notebooks";
import type { Credentials } from "./credentials";
import { databaseConfig } from "./database";
import { ownedProject, projectId as validId } from "./project-scope";
import { cellIdSchema, sharingSchema } from "./run-snapshots";
import { encodedJson, validText } from "./chat-context";
import { ServiceError } from "./http";
const source = z
  .string()
  .refine((value) => Buffer.byteLength(value, "utf8") <= 65536);
const cellSchema = z.discriminatedUnion("cell_type", [
  z
    .object({
      id: cellIdSchema,
      cell_type: z.literal("code"),
      source,
      language: z.enum(["python", "r"]),
      sharing: sharingSchema,
    })
    .strict(),
  z
    .object({ id: cellIdSchema, cell_type: z.literal("markdown"), source })
    .strict(),
  z.object({ id: cellIdSchema, cell_type: z.literal("raw"), source }).strict(),
]);
const actionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("create-notebook"),
      name: z.string().min(1).max(120),
      cells: z
        .array(cellSchema)
        .max(100)
        .refine(
          (cells) =>
            new Set(cells.map((cell) => cell.id)).size === cells.length,
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("change-cell"),
      notebookId: z.uuid(),
      revision: z.number().int().positive(),
      cell: cellSchema,
    })
    .strict(),
]);
export interface Proposal {
  id: string;
  state: "pending" | "accepted" | "rejected";
  action: z.infer<typeof actionSchema>;
  before: NotebookDocument["cells"][number] | null;
  receipt: { notebookId: string; revision: number } | null;
}
interface StoredProposal extends Proposal {
  acceptedRevision: number | null;
}
const columns = `id,state,action,before_value AS "before",receipt,accepted_revision AS "acceptedRevision"`;
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ServiceError(400, "INVALID_PROPOSAL");
  return parsed.data;
}
function cell(
  draft: z.infer<typeof cellSchema>,
): NotebookDocument["cells"][number] {
  return draft.cell_type === "code"
    ? {
        id: draft.id,
        cell_type: "code",
        source: draft.source,
        metadata: {
          aira: { language: draft.language, sharing: draft.sharing },
        },
        outputs: [],
        execution_count: null,
      }
    : {
        id: draft.id,
        cell_type: draft.cell_type,
        source: draft.source,
        metadata: {},
      };
}
/** @id CODE-PROP-CHANGES @implements REQ-PROP-001 REQ-NH-001 */
export class Proposals {
  private readonly pool: pg.Pool;
  constructor(
    private readonly operations: Operations,
    private readonly notebooks: Notebooks,
    state: string,
    credentials: Credentials,
  ) {
    this.pool = new pg.Pool({
      ...databaseConfig(state, credentials, "application"),
      max: 4,
    });
    this.pool.on("error", () =>
      console.error("PROPOSAL_DATABASE_CONNECTION_LOST"),
    );
  }
  private async read(
    client: pg.Pool | pg.Client,
    actor: string,
    projectId: string,
    id: string,
    lock = false,
  ): Promise<StoredProposal> {
    validId(id);
    const result = await client.query<StoredProposal>(
      `SELECT ${columns} FROM proposal_changes WHERE id=$1 AND actor=$2 AND project_id=$3 ${lock ? "FOR UPDATE" : ""}`,
      [id, actor, projectId],
    );
    if (result.rowCount !== 1)
      throw new ServiceError(404, "PROPOSAL_NOT_FOUND");
    return result.rows[0];
  }
  async propose(
    actor: string,
    projectId: string,
    input: unknown,
  ): Promise<Proposal> {
    const action = parse(actionSchema, input);
    encodedJson(
      action,
      12 * 1024 * 1024,
      "INVALID_PROPOSAL",
      "PROPOSAL_TOO_LARGE",
    );
    if (action.kind === "create-notebook") validText(action.name, 120, true);
    return this.operations.write(async (client) => {
      const project = await ownedProject(client, actor, projectId, true);
      if (project.status !== "active")
        throw new ServiceError(409, "PROJECT_ARCHIVED");
      let before: Proposal["before"] = null;
      if (action.kind === "change-cell") {
        const notebook = await this.notebooks.get(
          actor,
          project.id,
          action.notebookId,
        );
        if (notebook.revision !== action.revision)
          throw new ServiceError(409, "STALE_NOTEBOOK_REVISION");
        const existing = notebook.document.cells.find(
          (entry) => entry.id === action.cell.id,
        );
        if (!existing) throw new ServiceError(404, "CELL_NOT_FOUND");
        action.notebookId = notebook.id;
        before = existing;
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO proposal_changes(id,actor,project_id,chat_id,action,before_value) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [
          id,
          actor,
          project.id,
          project.chatId,
          JSON.stringify(action),
          before === null ? null : JSON.stringify(before),
        ],
      );
      return this.read(client, actor, project.id, id);
    });
  }
  async get(actor: string, projectId: string, id: string): Promise<Proposal> {
    await ownedProject(this.pool, actor, projectId);
    return this.read(this.pool, actor, projectId, id);
  }
  async list(actor: string, projectId: string): Promise<Proposal[]> {
    await ownedProject(this.pool, actor, projectId);
    return (
      await this.pool.query<StoredProposal>(
        `SELECT ${columns} FROM proposal_changes WHERE actor=$1 AND project_id=$2 ORDER BY created_at,id`,
        [actor, projectId],
      )
    ).rows;
  }
  async accept(
    actor: string,
    projectId: string,
    id: string,
    input: unknown,
  ): Promise<NonNullable<Proposal["receipt"]>> {
    const expected = parse(
      z.object({ revision: z.number().int().nonnegative() }).strict(),
      input,
    );
    return this.operations.write(async (client) => {
      const project = await ownedProject(client, actor, projectId, true);
      const proposal = await this.read(client, actor, project.id, id, true);
      if (proposal.state === "accepted") {
        if (proposal.acceptedRevision !== expected.revision)
          throw new ServiceError(409, "PROPOSAL_INTENT_CHANGED");
        if (!proposal.receipt)
          throw new ServiceError(503, "PROPOSAL_RECEIPT_UNAVAILABLE");
        return proposal.receipt;
      }
      if (proposal.state !== "pending")
        throw new ServiceError(409, "PROPOSAL_NOT_PENDING");
      if (project.status !== "active")
        throw new ServiceError(409, "PROJECT_ARCHIVED");
      const action = proposal.action;
      let receipt: NonNullable<Proposal["receipt"]>;
      if (action.kind === "create-notebook") {
        if (expected.revision !== 0)
          throw new ServiceError(409, "STALE_NOTEBOOK_REVISION");
        const notebook = await this.notebooks.createInTransaction(
          client,
          actor,
          project.id,
          {
            name: action.name,
            document: {
              nbformat: 4,
              nbformat_minor: 5,
              metadata: {},
              cells: action.cells.map(cell),
            },
          },
          { origin: "proposal", editor: null, proposalId: proposal.id },
        );
        receipt = { notebookId: notebook.id, revision: notebook.revision };
      } else {
        const notebook = await this.notebooks.get(
          actor,
          project.id,
          action.notebookId,
        );
        if (
          expected.revision !== action.revision ||
          notebook.revision !== action.revision
        )
          throw new ServiceError(409, "STALE_NOTEBOOK_REVISION");
        const index = notebook.document.cells.findIndex(
          (entry) => entry.id === action.cell.id,
        );
        if (index < 0) throw new ServiceError(409, "STALE_PROPOSAL_CELL");
        notebook.document.cells[index] = cell(action.cell);
        const saved = await this.notebooks.saveInTransaction(
          client,
          actor,
          project.id,
          notebook.id,
          { revision: action.revision, document: notebook.document },
          { origin: "proposal", editor: null, proposalId: proposal.id },
        );
        receipt = { notebookId: saved.id, revision: saved.revision };
      }
      await client.query(
        `UPDATE proposal_changes SET state='accepted',accepted_revision=$2,receipt=$3::jsonb WHERE id=$1`,
        [proposal.id, expected.revision, JSON.stringify(receipt)],
      );
      return receipt;
    });
  }
  async reject(
    actor: string,
    projectId: string,
    id: string,
  ): Promise<Proposal> {
    return this.operations.write(async (client) => {
      await ownedProject(client, actor, projectId);
      const proposal = await this.read(client, actor, projectId, id, true);
      if (proposal.state === "accepted")
        throw new ServiceError(409, "PROPOSAL_ALREADY_ACCEPTED");
      await client.query(
        "UPDATE proposal_changes SET state='rejected' WHERE id=$1",
        [proposal.id],
      );
      return this.read(client, actor, projectId, id);
    });
  }
  async close() {
    await this.pool.end();
  }
}
