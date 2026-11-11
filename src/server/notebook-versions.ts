import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type pg from "pg";
import { z } from "zod";
import type { Credentials } from "./credentials";
import type { Operations } from "./operations";
import type { Notebook, NotebookDocument, StoredNotebook } from "./notebooks";
import {
  NotebookGit,
  type GitHistoryEvent,
  type GitPrepared,
} from "./notebook-git";
import { ownedProject, projectId as validId } from "./project-scope";
import { ServiceError } from "./http";
import { validEditorName } from "../lib/markdown-metadata";

type ExportState = "pending" | "exported" | "error" | "blocked";
export interface GitStatus {
  generation: string | null;
  status: ExportState;
  errorCode: string | null;
  rebuilt: boolean;
}
export interface VersionSummary {
  id: string;
  revision: number;
  name: string;
  origin: string;
  editor: string | null;
  reason: string | null;
  proposalId: string | null;
  restoredFrom: number | null;
  createdAt: string;
  sha256: string;
  git: {
    state: ExportState;
    commit: string | null;
    errorCode: string | null;
    attempts: number;
  };
}
export interface VersionDetail {
  version: VersionSummary;
  document: NotebookDocument;
  name: string;
}
export interface VersionDiff {
  fromRevision: number;
  toRevision: number;
  nameChanged: boolean;
  beforeName: string;
  afterName: string;
  cells: {
    id: string;
    before: NotebookDocument["cells"][number] | null;
    after: NotebookDocument["cells"][number] | null;
    beforeIndex: number | null;
    afterIndex: number | null;
    changes: ("added" | "removed" | "source" | "type" | "metadata" | "order")[];
  }[];
}
export interface VersionMetadata {
  origin:
    | "create"
    | "import"
    | "baseline"
    | "save"
    | "patch"
    | "proposal"
    | "restore";
  editor?: string | null;
  reason?: string | null;
  proposalId?: string | null;
  restoredFrom?: number | null;
}
export interface NotebookVersionsOptions {
  clock?: {
    now(): number;
    sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  };
  exporter?: Pick<NotebookGit, "exportVersion">;
}
interface NotebookAccess {
  save(
    client: pg.Client,
    actor: string,
    projectId: string,
    id: string,
    input: unknown,
    metadata: VersionMetadata,
  ): Promise<StoredNotebook>;
  read(actor: string, projectId: string, id: string): Promise<Notebook>;
}
type Query = pg.Client | pg.Pool;
interface Generation {
  id: string;
  project_id: string;
  application_id: string;
  rebuilt: boolean;
  head: string | null;
}
interface Claimed extends GitHistoryEvent {
  generationId: string;
  expectedParent: string | null;
  prepared: GitPrepared | undefined;
  attempts: number;
}
const DISPLAY_BYTES = 12 * 1024 * 1024;
const MAX_REVISION = 2147483647;
const editor = z.string().trim().refine(validEditorName);
export const historyEditorSchema = editor;
export const historyReasonSchema = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),
  );
const cellMetadata = z.record(z.string(), z.json());
const sourceCell = z.discriminatedUnion("cell_type", [
  z
    .object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      cell_type: z.literal("code"),
      source: z.string(),
      metadata: cellMetadata,
      outputs: z.array(z.never()).max(0),
      execution_count: z.null(),
    })
    .strict(),
  z
    .object({
      id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      cell_type: z.enum(["markdown", "raw"]),
      source: z.string(),
      metadata: cellMetadata,
      attachments: z.record(z.string(), cellMetadata).optional(),
    })
    .strict(),
]);
const contentSchema = z
  .object({
    name: z.string().min(1).max(120),
    document: z
      .object({
        nbformat: z.literal(4),
        nbformat_minor: z.number().int().nonnegative(),
        metadata: cellMetadata,
        cells: z
          .array(sourceCell)
          .max(100)
          .refine(
            (cells) =>
              new Set(cells.map((cell) => cell.id)).size === cells.length,
          ),
      })
      .strict(),
  })
  .strict();
const summaryFields = `v.id::text AS id,v.revision,v.content->>'name' AS name,v.origin,v.editor,v.reason,
  v.proposal_id AS "proposalId",v.restored_from AS "restoredFrom",
  v.created_at::text AS "createdAt",v.sha256,
  jsonb_build_object('state',o.state,'commit',o.commit,'errorCode',o.error_code,'attempts',o.attempts) AS git`;
const versionJoin =
  "FROM notebook_versions v JOIN notebook_git_exports o ON o.version_id=v.id";
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ServiceError(400, "INVALID_NOTEBOOK_HISTORY");
  return parsed.data;
}
function revision(value: string) {
  if (
    value.length > 10 ||
    !/^[1-9][0-9]*$/.test(value) ||
    BigInt(value) > BigInt(MAX_REVISION)
  )
    throw new ServiceError(400, "INVALID_HISTORY_REVISION");
  return Number(value);
}
function cursor(value: string) {
  if (
    value.length > 19 ||
    !/^[1-9][0-9]*$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new ServiceError(400, "INVALID_HISTORY_CURSOR");
  return value;
}
function budget(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > DISPLAY_BYTES)
    throw new ServiceError(413, "NOTEBOOK_HISTORY_DISPLAY_TOO_LARGE");
}
function verified(canonical: string, sha256: string) {
  if (createHash("sha256").update(canonical, "utf8").digest("hex") !== sha256)
    throw new ServiceError(503, "NOTEBOOK_HISTORY_INTEGRITY_ERROR");
  let value: unknown;
  try {
    value = JSON.parse(canonical);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ServiceError(503, "NOTEBOOK_HISTORY_CONTENT_INVALID");
    throw error;
  }
  const parsed = contentSchema.safeParse(value);
  if (!parsed.success)
    throw new ServiceError(503, "NOTEBOOK_HISTORY_CONTENT_INVALID");
  return parsed.data;
}
function same(a: unknown, b: unknown): boolean {
  // Both objects come from PostgreSQL jsonb, whose key ordering is canonical.
  return JSON.stringify(a) === JSON.stringify(b);
}

/** @id CODE-NH-VERSIONS @implements REQ-NH-001 REQ-NH-002 REQ-NH-003 REQ-NH-004 REQ-NH-006 */
export class NotebookVersions {
  private readonly exporter: Pick<NotebookGit, "exportVersion">;
  private readonly clock: NonNullable<NotebookVersionsOptions["clock"]>;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;
  private wait: AbortController | undefined;
  private inFlight:
    | { project: string; generation: string; controller: AbortController }
    | undefined;
  private readonly rebuilds = new Map<
    string,
    { generation: string | null; result: Promise<{ git: GitStatus }> }
  >();
  private readonly retries = new Map<string, Promise<{ git: GitStatus }>>();

  constructor(
    private readonly operations: Operations,
    private readonly pool: pg.Pool,
    state: string,
    private readonly credentials: Credentials,
    private readonly notebooks: NotebookAccess,
    options: NotebookVersionsOptions = {},
  ) {
    this.exporter =
      options.exporter ?? new NotebookGit(state, credentials.applicationId);
    this.clock = options.clock ?? {
      now: Date.now,
      sleep: async (milliseconds, signal) => {
        await sleep(milliseconds, undefined, { signal });
      },
    };
  }

  async record(
    client: pg.Client,
    notebook: StoredNotebook,
    metadata: VersionMetadata,
  ) {
    this.operations.assertTransaction(client);
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO notebook_versions(notebook_id,project_id,actor,revision,content,sha256,origin,editor,reason,proposal_id,restored_from)
      SELECT n.id,l.project_id,l.actor,n.revision,c.content,
        encode(sha256(convert_to(c.content::text,'UTF8')),'hex'),$2,$3,$4,$5,$6
      FROM notebooks n JOIN notebook_links l USING(id)
      CROSS JOIN LATERAL (SELECT jsonb_build_object('name',n.name,'document',notebook_source_document(n.document)) AS content) c
      WHERE n.id=$1 RETURNING id::text
    `,
      [
        notebook.id,
        metadata.origin,
        metadata.editor ?? null,
        metadata.reason || null,
        metadata.proposalId ?? null,
        metadata.restoredFrom ?? null,
      ],
    );
    if (result.rowCount !== 1)
      throw new ServiceError(503, "NOTEBOOK_HISTORY_RECORD_FAILED");
    await client.query(
      "INSERT INTO notebook_git_projects(project_id) VALUES($1) ON CONFLICT DO NOTHING",
      [notebook.projectId],
    );
    await client.query(
      "INSERT INTO notebook_git_exports(version_id,project_id) VALUES($1,$2)",
      [result.rows[0].id, notebook.projectId],
    );
    this.wake();
  }

  private async scope(
    client: Query,
    actor: string,
    project: string,
    notebook: string,
    lock = false,
  ) {
    validId(notebook);
    const owned = await ownedProject(client, actor, project, lock);
    const found = await client.query(
      "SELECT n.id FROM notebooks n JOIN notebook_links l USING(id) WHERE n.id=$1 AND l.actor=$2 AND l.project_id=$3",
      [notebook, actor, owned.id],
    );
    if (found.rowCount !== 1) throw new ServiceError(404, "NOTEBOOK_NOT_FOUND");
    return owned;
  }
  private async status(client: Query, project: string): Promise<GitStatus> {
    const generation = (
      await client.query<Generation>(
        "SELECT * FROM notebook_git_generations WHERE project_id=$1 AND active",
        [project],
      )
    ).rows[0];
    const head = (
      await client.query<{ state: ExportState; error_code: string | null }>(
        "SELECT state,error_code FROM notebook_git_exports WHERE project_id=$1 AND state<>'exported' ORDER BY version_id LIMIT 1",
        [project],
      )
    ).rows[0];
    const projectState = (
      await client.query<{ rebuilt: boolean }>(
        "SELECT rebuilt FROM notebook_git_projects WHERE project_id=$1",
        [project],
      )
    ).rows[0];
    return {
      generation: generation?.id ?? null,
      status: head?.state ?? (generation ? "exported" : "pending"),
      errorCode: head?.error_code ?? null,
      rebuilt: generation?.rebuilt ?? projectState?.rebuilt ?? false,
    };
  }
  async list(
    actor: string,
    project: string,
    notebook: string,
    query: URLSearchParams,
  ) {
    await this.scope(this.pool, actor, project, notebook);
    const limitText = query.get("limit");
    const limit = limitText === null ? 50 : revision(limitText);
    if (
      limit > 50 ||
      query.getAll("limit").length > 1 ||
      query.getAll("before").length > 1
    )
      throw new ServiceError(400, "INVALID_HISTORY_PAGE");
    const before = query.has("before")
      ? cursor(query.get("before") ?? "")
      : null;
    const found = await this.pool.query<VersionSummary>(
      `
      SELECT ${summaryFields} ${versionJoin}
      WHERE v.notebook_id=$1 AND v.project_id=$2 AND v.actor=$3 AND ($4::bigint IS NULL OR v.id<$4)
      ORDER BY v.id DESC LIMIT $5
    `,
      [notebook, project, actor, before, limit + 1],
    );
    const versions = found.rows.slice(0, limit);
    return {
      versions,
      nextCursor: found.rows.length > limit ? versions.at(-1)!.id : null,
      git: await this.status(this.pool, project),
    };
  }
  private async snapshot(
    client: Query,
    actor: string,
    project: string,
    notebook: string,
    selected: number,
    display: boolean,
  ): Promise<VersionDetail> {
    const header = (
      await client.query<VersionSummary & { bytes: number }>(
        `
      SELECT ${summaryFields},octet_length(v.content::text) AS bytes ${versionJoin}
      WHERE v.notebook_id=$1 AND v.project_id=$2 AND v.actor=$3 AND v.revision=$4
    `,
        [notebook, project, actor, selected],
      )
    ).rows[0];
    if (!header) throw new ServiceError(404, "NOTEBOOK_VERSION_NOT_FOUND");
    if (display && header.bytes > DISPLAY_BYTES)
      throw new ServiceError(413, "NOTEBOOK_HISTORY_DISPLAY_TOO_LARGE");
    const row = (
      await client.query<{ canonical: string }>(
        "SELECT content::text AS canonical FROM notebook_versions WHERE id=$1",
        [header.id],
      )
    ).rows[0];
    const content = verified(row.canonical, header.sha256);
    const { bytes, ...version } = header;
    void bytes;
    const result = { version, ...content };
    if (display) budget(result);
    return result;
  }
  async detail(
    actor: string,
    project: string,
    notebook: string,
    selected: string,
  ) {
    const target = revision(selected);
    await this.scope(this.pool, actor, project, notebook);
    return this.snapshot(this.pool, actor, project, notebook, target, true);
  }
  async diff(
    actor: string,
    project: string,
    notebook: string,
    selected: string,
    against: string | null,
  ): Promise<VersionDiff> {
    const to = revision(selected);
    const from = revision(against ?? "");
    await this.scope(this.pool, actor, project, notebook);
    const before = await this.snapshot(
      this.pool,
      actor,
      project,
      notebook,
      from,
      true,
    );
    const after = await this.snapshot(
      this.pool,
      actor,
      project,
      notebook,
      to,
      true,
    );
    const old = new Map(
      before.document.cells.map((cell, index) => [cell.id, { cell, index }]),
    );
    const next = new Map(
      after.document.cells.map((cell, index) => [cell.id, { cell, index }]),
    );
    const cells: VersionDiff["cells"] = [];
    for (const id of new Set([...old.keys(), ...next.keys()])) {
      const a = old.get(id),
        b = next.get(id);
      const changes: VersionDiff["cells"][number]["changes"] = [];
      if (!a) changes.push("added");
      else if (!b) changes.push("removed");
      else {
        if (a.cell.source !== b.cell.source) changes.push("source");
        if (a.cell.cell_type !== b.cell.cell_type) changes.push("type");
        if (
          !same(a.cell.metadata, b.cell.metadata) ||
          !same(
            "attachments" in a.cell ? a.cell.attachments : undefined,
            "attachments" in b.cell ? b.cell.attachments : undefined,
          )
        )
          changes.push("metadata");
        if (a.index !== b.index) changes.push("order");
      }
      if (changes.length)
        cells.push({
          id,
          before: a?.cell ?? null,
          after: b?.cell ?? null,
          beforeIndex: a?.index ?? null,
          afterIndex: b?.index ?? null,
          changes,
        });
    }
    const result: VersionDiff = {
      fromRevision: from,
      toRevision: to,
      nameChanged: before.name !== after.name,
      beforeName: before.name,
      afterName: after.name,
      cells,
    };
    budget(result);
    return result;
  }
  async restore(
    actor: string,
    project: string,
    notebook: string,
    selected: string,
    input: unknown,
  ) {
    const target = revision(selected);
    const value = parse(
      z
        .object({
          revision: z.number().int().positive().max(MAX_REVISION),
          editorName: editor,
        })
        .strict(),
      input,
    );
    await this.operations.write(async (client) => {
      const owned = await this.scope(client, actor, project, notebook, true);
      if (owned.status !== "active")
        throw new ServiceError(409, "PROJECT_ARCHIVED");
      const saved = await this.snapshot(
        client,
        actor,
        project,
        notebook,
        target,
        false,
      );
      await this.notebooks.save(
        client,
        actor,
        project,
        notebook,
        {
          revision: value.revision,
          name: saved.name,
          document: saved.document,
        },
        { origin: "restore", editor: value.editorName, restoredFrom: target },
      );
    });
    return this.notebooks.read(actor, project, notebook);
  }

  async retry(
    actor: string,
    project: string,
    notebook: string,
    input: unknown,
  ) {
    project = project.toLowerCase();
    parse(z.object({}).strict(), input);
    const existing = this.retries.get(project);
    if (existing) {
      await this.scope(this.pool, actor, project, notebook);
      return existing;
    }
    const result = this.operations.write(async (client) => {
      await this.scope(client, actor, project, notebook, true);
      await client.query(
        `
        UPDATE notebook_git_exports SET state='pending',attempts=0,error_code=NULL,next_attempt_ms=0
        WHERE version_id=(SELECT version_id FROM notebook_git_exports
          WHERE project_id=$1 AND state<>'exported' ORDER BY version_id LIMIT 1)
          AND state IN ('error','blocked')
      `,
        [project],
      );
      return { git: await this.status(client, project) };
    });
    this.retries.set(project, result);
    try {
      const response = await result;
      this.wake();
      return response;
    } finally {
      if (this.retries.get(project) === result) this.retries.delete(project);
    }
  }
  async rebuild(
    actor: string,
    project: string,
    notebook: string,
    input: unknown,
  ) {
    project = project.toLowerCase();
    const value = parse(
      z
        .object({ generation: z.uuid().nullable(), confirmed: z.literal(true) })
        .strict(),
      input,
    );
    if (value.generation !== null)
      value.generation = value.generation.toLowerCase();
    const existing = this.rebuilds.get(project);
    if (existing?.generation === value.generation) {
      await this.scope(this.pool, actor, project, notebook);
      return existing.result;
    }
    // Reserve the project request before asynchronous scope reads can overtake it.
    const result = (async () => {
      await this.scope(this.pool, actor, project, notebook);
      return this.operations.write(async (client) => {
        await this.scope(client, actor, project, notebook, true);
        const previous = (
          await client.query<Generation>(
            "SELECT * FROM notebook_git_generations WHERE project_id=$1 AND active FOR UPDATE",
            [project],
          )
        ).rows[0];
        if ((previous?.id ?? null) !== value.generation)
          throw new ServiceError(409, "STALE_HISTORY_GENERATION");
        if (previous)
          await client.query(
            "UPDATE notebook_git_generations SET active=false WHERE id=$1",
            [previous.id],
          );
        const id = randomUUID();
        await client.query(
          `
        INSERT INTO notebook_git_generations(id,project_id,application_id,rebuilt,parent_generation)
        VALUES($1,$2,$3,true,$4)
      `,
          [id, project, this.credentials.applicationId, previous?.id ?? null],
        );
        await client.query(
          "UPDATE notebook_git_projects SET rebuilt=true WHERE project_id=$1",
          [project],
        );
        await client.query(
          `
        UPDATE notebook_git_exports SET generation_id=$2,state='pending',attempts=0,error_code=NULL,commit=NULL,
          expected_parent=NULL,prepared_parent=NULL,prepared_tree=NULL,prepared_commit=NULL,next_attempt_ms=0
        WHERE project_id=$1
      `,
          [project, id],
        );
        return { git: await this.status(client, project) };
      });
    })();
    this.rebuilds.set(project, { generation: value.generation, result });
    try {
      const response = await result;
      if (
        this.inFlight?.project === project &&
        this.inFlight.generation !== response.git.generation
      )
        this.inFlight.controller.abort();
      this.wake();
      return response;
    } finally {
      if (this.rebuilds.get(project)?.result === result)
        this.rebuilds.delete(project);
    }
  }

  private wake() {
    this.wait?.abort();
  }
  async start() {
    if (this.stopping) throw new ServiceError(503, "NOTEBOOK_HISTORY_STOPPED");
    if (this.running) return;
    await this.operations.write(async (client) => {
      await client.query(`
        UPDATE notebook_git_exports SET state='blocked',
          error_code=COALESCE(error_code,'GIT_ATTEMPTS_EXHAUSTED')
        WHERE state IN ('pending','error') AND attempts>=3
      `);
    });
    if (this.stopping || this.running) return;
    this.controller = new AbortController();
    this.running = this.run(this.controller.signal);
  }
  async stop() {
    this.stopping = true;
    this.controller?.abort();
    this.inFlight?.controller.abort();
    this.wake();
    await this.running;
  }
  close() {
    return this.stop();
  }
  private async pause(milliseconds: number, signal: AbortSignal) {
    if (signal.aborted || this.stopping) return;
    const wait = new AbortController();
    this.wait = wait;
    const aborted = () => wait.abort();
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) wait.abort();
    try {
      await this.clock.sleep(milliseconds, wait.signal);
    } catch (error) {
      if (!wait.signal.aborted) throw error;
    } finally {
      signal.removeEventListener("abort", aborted);
      if (this.wait === wait) this.wait = undefined;
    }
  }
  private async claim(
    signal: AbortSignal,
  ): Promise<{ event: Claimed | null; delay: number }> {
    return this.operations.write(async (client) => {
      if (signal.aborted) return { event: null, delay: 1000 };
      const now = this.clock.now();
      const row = (
        await client.query<{
          version_id: string;
          project_id: string;
          state: ExportState;
          attempts: number;
          generation_id: string | null;
          expected_parent: string | null;
          prepared_parent: string | null;
          prepared_tree: string | null;
          prepared_commit: string | null;
          next_attempt_ms: string;
        }>(
          `
        SELECT e.* FROM notebook_git_exports e
        WHERE e.state IN ('pending','error') AND e.attempts<3 AND e.next_attempt_ms<=$1
          AND NOT EXISTS(SELECT 1 FROM notebook_git_exports earlier
            WHERE earlier.project_id=e.project_id AND earlier.state<>'exported'
              AND earlier.version_id<e.version_id)
        ORDER BY e.version_id LIMIT 1
      `,
          [now],
        )
      ).rows[0];
      if (!row) {
        const next = (
          await client.query<{ at: string | null }>(`
          SELECT min(e.next_attempt_ms) AS at FROM notebook_git_exports e
          WHERE e.state IN ('pending','error') AND e.attempts<3
            AND NOT EXISTS(SELECT 1 FROM notebook_git_exports earlier
              WHERE earlier.project_id=e.project_id AND earlier.state<>'exported'
                AND earlier.version_id<e.version_id)
        `)
        ).rows[0].at;
        return {
          event: null,
          delay:
            next === null
              ? 1000
              : Math.min(Math.max(1, Number(next) - now), 30000),
        };
      }
      let generation = (
        await client.query<Generation>(
          "SELECT * FROM notebook_git_generations WHERE project_id=$1 AND active FOR UPDATE",
          [row.project_id],
        )
      ).rows[0];
      if (!generation) {
        generation = (
          await client.query<Generation>(
            `
          INSERT INTO notebook_git_generations(id,project_id,application_id,rebuilt)
          SELECT $1,$2,$3,rebuilt FROM notebook_git_projects WHERE project_id=$2 RETURNING *
        `,
            [randomUUID(), row.project_id, this.credentials.applicationId],
          )
        ).rows[0];
      }
      if (generation.application_id !== this.credentials.applicationId) {
        await client.query(
          "UPDATE notebook_git_exports SET state='blocked',error_code='GIT_GENERATION_IDENTITY_MISMATCH' WHERE version_id=$1",
          [row.version_id],
        );
        return { event: null, delay: 1 };
      }
      const event = (
        await client.query<GitHistoryEvent>(
          `
        SELECT id::text,project_id AS "projectId",notebook_id AS "notebookId",revision,
          content::text AS "canonicalContent",sha256,created_at::text AS "recordedAt",origin,editor,reason,
          proposal_id AS "proposalId",restored_from AS "restoredFrom"
        FROM notebook_versions WHERE id=$1
      `,
          [row.version_id],
        )
      ).rows[0];
      const expectedParent = row.prepared_commit
        ? row.expected_parent
        : generation.head;
      await client.query(
        `
        UPDATE notebook_git_exports SET attempts=attempts+1,generation_id=$2,expected_parent=$3,
          state='pending',error_code=NULL,next_attempt_ms=0 WHERE version_id=$1
      `,
        [event.id, generation.id, expectedParent],
      );
      return {
        event: {
          ...event,
          generationId: generation.id,
          expectedParent,
          prepared:
            row.prepared_tree && row.prepared_commit
              ? {
                  parent: row.prepared_parent,
                  tree: row.prepared_tree,
                  commit: row.prepared_commit,
                }
              : undefined,
          attempts: row.attempts + 1,
        },
        delay: 0,
      };
    });
  }
  private async fenced(client: pg.Client, event: Claimed, signal: AbortSignal) {
    this.operations.assertTransaction(client);
    if (signal.aborted || this.stopping)
      throw new ServiceError(503, "NOTEBOOK_HISTORY_STOPPED");
    const generation = await client.query(
      "SELECT id FROM notebook_git_generations WHERE id=$1 AND project_id=$2 AND application_id=$3 AND active FOR UPDATE",
      [event.generationId, event.projectId, this.credentials.applicationId],
    );
    if (generation.rowCount !== 1)
      throw new ServiceError(409, "HISTORY_GENERATION_CHANGED");
  }
  private async export(event: Claimed, signal: AbortSignal) {
    const controller = new AbortController();
    const aborted = () => controller.abort();
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) controller.abort();
    this.inFlight = {
      project: event.projectId,
      generation: event.generationId,
      controller,
    };
    let probe: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (!probe && !controller.signal.aborted) {
        probe = this.operations
          .write(async (client) => {
            await this.fenced(client, event, controller.signal);
          })
          .catch((error: unknown) => {
            if (
              error instanceof ServiceError &&
              (error.status === 503 ||
                error.code === "HISTORY_GENERATION_CHANGED")
            )
              controller.abort();
            else {
              controller.abort();
              console.error("NOTEBOOK_HISTORY_LEASE_PROBE_FAILED");
            }
          })
          .finally(() => {
            probe = undefined;
          });
      }
    }, 1000);
    timer.unref();
    try {
      verified(event.canonicalContent, event.sha256);
      const prepared = await this.exporter.exportVersion(
        {
          generationId: event.generationId,
          applicationId: this.credentials.applicationId,
          projectId: event.projectId,
        },
        event,
        {
          expectedParent: event.expectedParent,
          prepared: event.prepared,
          signal: controller.signal,
          onPrepared: async (value) => {
            if (value.parent !== event.expectedParent)
              throw new ServiceError(503, "GIT_PREPARED_PARENT_MISMATCH");
            await this.operations.write(async (client) => {
              await this.fenced(client, event, controller.signal);
              await client.query(
                `
              UPDATE notebook_git_exports SET prepared_parent=$3,prepared_tree=$4,prepared_commit=$5
              WHERE version_id=$1 AND generation_id=$2
            `,
                [
                  event.id,
                  event.generationId,
                  value.parent,
                  value.tree,
                  value.commit,
                ],
              );
            });
          },
          beforeRefUpdate: async () => {
            await this.operations.write(async (client) => {
              await this.fenced(client, event, controller.signal);
            });
          },
        },
      );
      await this.operations.write(async (client) => {
        await this.fenced(client, event, controller.signal);
        const changed = await client.query(
          `
          UPDATE notebook_git_exports SET state='exported',commit=$3,error_code=NULL,next_attempt_ms=0
          WHERE version_id=$1 AND generation_id=$2
        `,
          [event.id, event.generationId, prepared.commit],
        );
        if (changed.rowCount !== 1)
          throw new ServiceError(409, "HISTORY_GENERATION_CHANGED");
        await client.query(
          `
          INSERT INTO notebook_git_receipts(generation_id,version_id,parent,tree,commit)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
        `,
          [
            event.generationId,
            event.id,
            prepared.parent,
            prepared.tree,
            prepared.commit,
          ],
        );
        await client.query(
          "UPDATE notebook_git_generations SET head=$2 WHERE id=$1 AND active",
          [event.generationId, prepared.commit],
        );
      });
    } catch (error) {
      if (!controller.signal.aborted && !this.stopping) {
        const code =
          error instanceof ServiceError ? error.code : "GIT_EXPORT_FAILED";
        const permanent =
          /LOCK|DIVERG|UNSAFE|INTEGRITY|TOO_LARGE|BUDGET|MARKER|OWNERSHIP/.test(
            code,
          );
        await this.operations.write(async (client) => {
          await this.fenced(client, event, controller.signal);
          await client.query(
            `
            UPDATE notebook_git_exports SET state=$3,error_code=$4,next_attempt_ms=$5
            WHERE version_id=$1 AND generation_id=$2
          `,
            [
              event.id,
              event.generationId,
              permanent || event.attempts >= 3 ? "blocked" : "error",
              code,
              this.clock.now() + 1000 * 2 ** (event.attempts - 1),
            ],
          );
        });
      }
    } finally {
      clearInterval(timer);
      await probe;
      signal.removeEventListener("abort", aborted);
      this.inFlight = undefined;
    }
  }
  private async run(signal: AbortSignal) {
    try {
      while (!signal.aborted && !this.stopping) {
        const claimed = await this.claim(signal);
        if (claimed.event) await this.export(claimed.event, signal);
        else await this.pause(claimed.delay, signal);
      }
    } catch (error) {
      this.controller?.abort();
      if (!(
        error instanceof ServiceError &&
        (error.code === "WRITER_LEASE_UNAVAILABLE" ||
          error.code === "WRITER_FENCE_REJECTED")
      ))
        console.error("NOTEBOOK_HISTORY_WORKER_STOPPED");
    }
  }
}
