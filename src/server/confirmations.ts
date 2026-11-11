import pg from "pg";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import type { Operations } from "./operations";
import type { Notebooks, NotebookSource } from "./notebooks";
import type { Files } from "./files";
import type { Provenance } from "./provenance";
import type { Credentials } from "./credentials";
import { databaseConfig } from "./database";
import { ownedProject, projectId as validId } from "./project-scope";
import { encodedJson } from "./chat-context";
import { cellIdSchema, plainRunText } from "./run-snapshots";
import { previewFile } from "./file-preview";
import { ServiceError } from "./http";
export type ConfirmationKind = "execution" | "disclosure";
export interface ExecutionSnapshot extends NotebookSource {
  kind: "execution";
  actor: string;
  projectId: string;
  chatId: string;
  inputs: { id: string; workspaceName: string; size: number; sha256: string }[];
  kernelEpoch: string;
  imageDigest: string;
}
export interface DisclosureSource {
  kind: "run" | "file";
  id: string;
  start: number;
  end: number;
  sha256: string;
  notebookId?: string;
  cellId?: string;
  sequence?: string;
  revision?: number;
}
export interface DisclosureSnapshot {
  kind: "disclosure";
  actor: string;
  projectId: string;
  chatId: string;
  text: string;
  sources: DisclosureSource[];
}
export interface Confirmation {
  id: string;
  kind: ConfirmationKind;
  fingerprint: string;
  expiresAt: string;
  snapshot: ExecutionSnapshot | DisclosureSnapshot;
}
export interface ConfirmedReceipt {
  jobId: string;
  requestId: string;
  confirmationId: string;
  kind: ConfirmationKind;
  fingerprint: string;
  snapshot: ExecutionSnapshot | DisclosureSnapshot;
}
interface StoredConfirmation extends Confirmation {
  actor: string;
  projectId: string;
  grantId: string;
  revoked: boolean;
}
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid().transform((value) => value.toLowerCase());
const executionSchema = z
  .object({
    notebookId: uuid,
    cellId: cellIdSchema,
    revision: z.number().int().positive(),
    inputs: z
      .array(z.object({ id: uuid, name: z.string(), sha256 }).strict())
      .max(32),
  })
  .strict();
const selectionSchema = z
  .object({
    kind: z.enum(["run", "file"]),
    id: uuid,
    start: z.number().int().nonnegative().max(65536),
    end: z.number().int().positive().max(65536),
  })
  .strict()
  .refine((value) => value.end > value.start);
const disclosureSchema = z
  .object({ selections: z.array(selectionSchema).min(1).max(32) })
  .strict();
const admissionSchema = z
  .object({ confirmationId: uuid, requestId: uuid, fingerprint: sha256 })
  .strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ServiceError(400, "INVALID_CONFIRMATION");
  return parsed.data;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined)
      throw new ServiceError(400, "INVALID_CONFIRMATION_SNAPSHOT");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}
function fingerprint(snapshot: Confirmation["snapshot"]): string {
  encodedJson(
    snapshot,
    12 * 1024 * 1024,
    "INVALID_CONFIRMATION_SNAPSHOT",
    "CONFIRMATION_SNAPSHOT_TOO_LARGE",
  );
  return createHash("sha256")
    .update("aira-confirmation-v1\0")
    .update(canonical(snapshot))
    .digest("hex");
}
const fields = `id,actor,project_id AS "projectId",kind,grant_id AS "grantId",fingerprint,snapshot,expires_at::text AS "expiresAt",revoked`;
/** @id CODE-PROP-CONFIRM @implements REQ-PROP-002 REQ-PROP-003 REQ-PROP-004 */
export class Confirmations {
  private readonly pool: pg.Pool;
  private readonly now: () => number;
  private readonly imageDigest: string;
  constructor(
    private readonly operations: Operations,
    private readonly notebooks: Notebooks,
    private readonly files: Files,
    private readonly provenance: Provenance,
    state: string,
    credentials: Credentials,
    options: { imageDigest: string; now?: () => number },
  ) {
    if (!/^sha256:[a-f0-9]{64}$/.test(options.imageDigest))
      throw new ServiceError(503, "INVALID_RUNTIME_IMAGE_DIGEST");
    this.imageDigest = options.imageDigest;
    this.now = options.now ?? Date.now;
    this.pool = new pg.Pool({
      ...databaseConfig(state, credentials, "application"),
      max: 4,
    });
    this.pool.on("error", () =>
      console.error("CONFIRMATION_DATABASE_CONNECTION_LOST"),
    );
  }
  private async stamp(client: pg.Client, notebookId: string, create: boolean) {
    this.operations.assertTransaction(client);
    if (create)
      await client.query(
        `INSERT INTO runtime_reservations(notebook_id,kernel_epoch,image_digest,writer_epoch)
       SELECT $1,$2,$3,epoch FROM writer_control ON CONFLICT(notebook_id) DO NOTHING`,
        [notebookId, randomUUID(), this.imageDigest],
      );
    const result = await client.query<{
      kernelEpoch: string;
      imageDigest: string;
      current: boolean;
      state: string;
    }>(
      `SELECT kernel_epoch AS "kernelEpoch",image_digest AS "imageDigest",
       state,writer_epoch=(SELECT epoch FROM writer_control) AS current FROM runtime_reservations WHERE notebook_id=$1 FOR UPDATE`,
      [notebookId],
    );
    if (result.rowCount !== 1 || !result.rows[0].current)
      throw new ServiceError(409, "RUNTIME_EPOCH_CHANGED");
    const row = result.rows[0];
    if (row.state === "closing" || row.state === "uncertain")
      throw new ServiceError(409, "RUNTIME_NOT_READY");
    if (row.imageDigest !== this.imageDigest)
      throw new ServiceError(409, "RUNTIME_IMAGE_CHANGED");
    return { kernelEpoch: row.kernelEpoch, imageDigest: row.imageDigest };
  }
  private async execution(
    client: pg.Client,
    actor: string,
    projectId: string,
    chatId: string,
    input: z.infer<typeof executionSchema>,
    create: boolean,
  ): Promise<ExecutionSnapshot> {
    let source: NotebookSource;
    try {
      source = await this.notebooks.source(
        actor,
        projectId,
        input.notebookId,
        input.cellId,
      );
    } catch (error) {
      if (
        !create &&
        error instanceof ServiceError &&
        error.code === "CELL_NOT_FOUND"
      )
        throw new ServiceError(409, "CONFIRMATION_SNAPSHOT_CHANGED");
      throw error;
    }
    if (source.revision !== input.revision)
      throw new ServiceError(409, "STALE_NOTEBOOK_REVISION");
    const selected = await this.files.select(
      actor,
      projectId,
      input.inputs.map((file) => ({ id: file.id, name: file.name })),
    );
    if (
      selected.some((file, index) => file.sha256 !== input.inputs[index].sha256)
    )
      throw new ServiceError(409, "INPUT_VERSION_CHANGED");
    const stamp = await this.stamp(client, source.notebookId, create);
    return {
      kind: "execution",
      actor,
      projectId,
      chatId,
      ...source,
      inputs: selected.map((file) => ({
        id: file.id,
        workspaceName: file.workspaceName,
        size: file.size,
        sha256: file.sha256,
      })),
      ...stamp,
    };
  }
  private async disclosure(
    actor: string,
    projectId: string,
    chatId: string,
    input: z.infer<typeof disclosureSchema>,
  ): Promise<DisclosureSnapshot> {
    const sources: DisclosureSource[] = [],
      pieces: string[] = [];
    for (const selection of input.selections) {
      let text: string, identity: Omit<DisclosureSource, "start" | "end">;
      if (selection.kind === "file") {
        const file = await this.files.get(actor, projectId, selection.id);
        const preview = await previewFile(
          this.files,
          actor,
          projectId,
          file.id,
        );
        if (preview.kind !== "text")
          throw new ServiceError(415, "DISCLOSURE_REQUIRES_TEXT");
        text = preview.text;
        identity = { kind: "file", id: file.id, sha256: file.sha256 };
      } else {
        const run = await this.provenance.get(actor, projectId, selection.id);
        if (!run.outputs || run.status === "queued" || run.status === "running")
          throw new ServiceError(409, "RESULT_UNAVAILABLE");
        text = plainRunText(run.outputs);
        identity = {
          kind: "run",
          id: run.id,
          sha256: createHash("sha256").update(text).digest("hex"),
          notebookId: run.notebookId,
          cellId: run.cellId,
          sequence: run.sequence,
          revision: run.revision,
        };
      }
      const characters = [...text];
      if (selection.end > characters.length)
        throw new ServiceError(400, "INVALID_DISCLOSURE_RANGE");
      sources.push({ ...identity, start: selection.start, end: selection.end });
      pieces.push(characters.slice(selection.start, selection.end).join(""));
    }
    const text = pieces.join("\n\n");
    if (Buffer.byteLength(text, "utf8") > 32 * 1024)
      throw new ServiceError(413, "DISCLOSURE_BUDGET_EXCEEDED");
    return { kind: "disclosure", actor, projectId, chatId, text, sources };
  }
  private async issue(
    client: pg.Client,
    snapshot: Confirmation["snapshot"],
  ): Promise<Confirmation> {
    const hash = fingerprint(snapshot),
      id = randomUUID();
    const grantId = await this.operations.grantInTransaction(
      client,
      snapshot.actor,
      snapshot.kind === "execution" ? "execution" : "chat",
      hash,
      300000,
    );
    const result = await client.query<StoredConfirmation>(
      `INSERT INTO confirmations(id,actor,project_id,chat_id,kind,grant_id,fingerprint,snapshot,expires_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb,expires_at FROM grants WHERE id=$6 RETURNING ${fields}`,
      [
        id,
        snapshot.actor,
        snapshot.projectId,
        snapshot.chatId,
        snapshot.kind,
        grantId,
        hash,
        JSON.stringify(snapshot),
      ],
    );
    return this.public(result.rows[0]);
  }
  private public(row: StoredConfirmation): Confirmation {
    return {
      id: row.id,
      kind: row.kind,
      fingerprint: row.fingerprint,
      expiresAt: row.expiresAt,
      snapshot: row.snapshot,
    };
  }
  private async load(
    client: pg.Pool | pg.Client,
    actor: string,
    projectId: string,
    id: string,
  ): Promise<StoredConfirmation | null> {
    const result = await client.query<StoredConfirmation>(
      `SELECT ${fields} FROM confirmations WHERE id=$1`,
      [id],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (row.actor !== actor || row.projectId !== projectId)
      throw new ServiceError(404, "CONFIRMATION_NOT_FOUND");
    if (fingerprint(row.snapshot) !== row.fingerprint)
      throw new ServiceError(503, "CONFIRMATION_INTEGRITY_ERROR");
    return row;
  }
  async prepareExecution(
    actor: string,
    projectId: string,
    input: unknown,
  ): Promise<Confirmation> {
    const value = parse(executionSchema, input);
    return this.operations.write(async (client) => {
      const project = await ownedProject(client, actor, projectId, true);
      if (project.status !== "active")
        throw new ServiceError(409, "PROJECT_ARCHIVED");
      return this.issue(
        client,
        await this.execution(
          client,
          actor,
          project.id,
          project.chatId,
          value,
          true,
        ),
      );
    });
  }
  /** @id CODE-CITE-DISCLOSURE @implements REQ-CITE-003 */
  async readDisclosure(
    actor: string,
    projectId: string,
    input: unknown,
  ): Promise<DisclosureSnapshot> {
    const value = parse(disclosureSchema, input);
    const project = await ownedProject(this.pool, actor, projectId);
    return this.disclosure(actor, project.id, project.chatId, value);
  }
  async prepareDisclosure(
    actor: string,
    projectId: string,
    input: unknown,
  ): Promise<Confirmation> {
    const value = parse(disclosureSchema, input);
    return this.operations.write(async (client) => {
      const project = await ownedProject(client, actor, projectId, true);
      if (project.status !== "active")
        throw new ServiceError(409, "PROJECT_ARCHIVED");
      return this.issue(
        client,
        await this.disclosure(actor, project.id, project.chatId, value),
      );
    });
  }
  async get(
    actor: string,
    projectId: string,
    id: string,
  ): Promise<Confirmation> {
    validId(id);
    const project = await ownedProject(this.pool, actor, projectId);
    const row = await this.load(this.pool, actor, project.id, id);
    if (!row) throw new ServiceError(404, "CONFIRMATION_NOT_FOUND");
    return this.public(row);
  }
  async deny(actor: string, projectId: string, id: string): Promise<void> {
    validId(id);
    await this.operations.write(async (client) => {
      const project = await ownedProject(client, actor, projectId);
      const row = await this.load(client, actor, project.id, id);
      if (!row) throw new ServiceError(404, "CONFIRMATION_NOT_FOUND");
      await client.query("UPDATE confirmations SET revoked=true WHERE id=$1", [
        row.id,
      ]);
    });
  }
  async admit(
    actor: string,
    projectId: string,
    kind: ConfirmationKind,
    input: unknown,
  ): Promise<{ receipt: ConfirmedReceipt; admitted: boolean }> {
    const value = parse(admissionSchema, input);
    parse(z.enum(["execution", "disclosure"]), kind);
    return this.operations.write(async (client) => {
      const project = await ownedProject(client, actor, projectId, true);
      const confirmation = await this.load(
        client,
        actor,
        project.id,
        value.confirmationId,
      );
      if (!confirmation) throw new ServiceError(409, "CONFIRMATION_REQUIRED");
      const prior = await client.query<{
        projectId: string;
        fingerprint: string;
        receipt: ConfirmedReceipt | null;
      }>(
        `SELECT j.project_id AS "projectId",j.fingerprint,r.receipt FROM jobs j
         LEFT JOIN confirmed_receipts r ON r.job_id=j.id WHERE j.actor=$1 AND j.request_id=$2`,
        [actor, value.requestId],
      );
      if (prior.rowCount) {
        const original = prior.rows[0];
        if (original.projectId !== project.id)
          throw new ServiceError(404, "RECEIPT_NOT_FOUND");
        const receipt = original.receipt;
        if (
          !receipt ||
          receipt.kind !== kind ||
          receipt.confirmationId !== confirmation.id ||
          receipt.requestId !== value.requestId ||
          receipt.fingerprint !== value.fingerprint ||
          original.fingerprint !== receipt.fingerprint ||
          receipt.snapshot.actor !== actor ||
          receipt.snapshot.projectId !== project.id ||
          fingerprint(receipt.snapshot) !== receipt.fingerprint
        )
          throw new ServiceError(409, "REQUEST_INTENT_CONFLICT");
        return { receipt, admitted: false };
      }
      if (project.status !== "active")
        throw new ServiceError(409, "PROJECT_ARCHIVED");
      if (
        confirmation.kind !== kind ||
        confirmation.fingerprint !== value.fingerprint ||
        confirmation.revoked
      )
        throw new ServiceError(409, "CONFIRMATION_REQUIRED");
      const grant = (
        await client.query<{ consumed_by: string | null; expired: boolean }>(
          "SELECT consumed_by,expires_at<=clock_timestamp() AS expired FROM grants WHERE id=$1 FOR UPDATE",
          [confirmation.grantId],
        )
      ).rows[0];
      if (!grant || grant.consumed_by !== null)
        throw new ServiceError(409, "CONFIRMATION_REQUIRED");
      if (grant.expired || this.now() >= Date.parse(confirmation.expiresAt))
        throw new ServiceError(410, "CONFIRMATION_EXPIRED");
      const sealed = confirmation.snapshot;
      const current =
        sealed.kind === "execution"
          ? await this.execution(
              client,
              actor,
              project.id,
              project.chatId,
              {
                notebookId: sealed.notebookId,
                cellId: sealed.cellId,
                revision: sealed.revision,
                inputs: sealed.inputs.map((file) => ({
                  id: file.id,
                  name: file.workspaceName,
                  sha256: file.sha256,
                })),
              },
              false,
            )
          : await this.disclosure(actor, project.id, project.chatId, {
              selections: sealed.sources.map((entry) => ({
                kind: entry.kind,
                id: entry.id,
                start: entry.start,
                end: entry.end,
              })),
            });
      if (fingerprint(current) !== confirmation.fingerprint)
        throw new ServiceError(409, "CONFIRMATION_SNAPSHOT_CHANGED");
      let job;
      try {
        job = await this.operations.admitInTransaction(
          client,
          {
            actor,
            requestId: value.requestId,
            purpose: kind === "execution" ? "execution" : "chat",
            fingerprint: confirmation.fingerprint,
            grantId: confirmation.grantId,
          },
          project.id,
        );
      } catch (error) {
        if (
          error instanceof ServiceError &&
          error.code === "CONFIRMATION_REQUIRED"
        ) {
          const expired = await client.query(
            "SELECT id FROM grants WHERE id=$1 AND consumed_by IS NULL AND expires_at<=clock_timestamp()",
            [confirmation.grantId],
          );
          if (expired.rowCount)
            throw new ServiceError(410, "CONFIRMATION_EXPIRED");
        }
        throw error;
      }
      const receipt: ConfirmedReceipt = {
        jobId: job.id,
        requestId: value.requestId,
        confirmationId: confirmation.id,
        kind,
        fingerprint: confirmation.fingerprint,
        snapshot: sealed,
      };
      await client.query(
        "INSERT INTO confirmed_receipts(job_id,confirmation_id,receipt) VALUES($1,$2,$3::jsonb)",
        [job.id, confirmation.id, JSON.stringify(receipt)],
      );
      return { receipt, admitted: true };
    });
  }
  async close() {
    await this.pool.end();
  }
}
