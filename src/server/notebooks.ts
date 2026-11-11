import pg from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { databaseConfig } from "./database";
import type { Credentials } from "./credentials";
import type { Operations } from "./operations";
import type { Provenance } from "./provenance";
import type { CapturedRun, RunOutput, SharedVariable } from "./run-snapshots";
import { ServiceError } from "./http";
import { ownedProject, projectId as validId } from "./project-scope";
import { encodedJson } from "./chat-context";
import {
  NotebookVersions,
  historyEditorSchema,
  historyReasonSchema,
  type NotebookVersionsOptions,
  type VersionMetadata,
} from "./notebook-versions";
import {
  sharingSchema,
  cellIdSchema,
  outputsSchema,
  projectRun,
} from "./run-snapshots";
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface CodeCell {
  id: string;
  cell_type: "code";
  source: string;
  metadata: Record<string, JsonValue>;
  outputs: RunOutput[];
  execution_count: number | null;
}
export interface TextCell {
  id: string;
  cell_type: "markdown" | "raw";
  source: string;
  metadata: Record<string, JsonValue>;
  attachments?: Record<string, Record<string, JsonValue>>;
}
export interface NotebookDocument {
  nbformat: 4;
  nbformat_minor: number;
  metadata: Record<string, JsonValue>;
  cells: (CodeCell | TextCell)[];
}
export interface StoredNotebook {
  id: string;
  actor: string;
  projectId: string;
  chatId: string;
  name: string;
  revision: number;
  document: NotebookDocument;
}
export interface Notebook extends StoredNotebook {
  results: Record<
    string,
    {
      runId: string;
      status: CapturedRun["status"];
      stale: boolean;
      lostState: boolean;
      historicalOutputs: RunOutput[] | null;
      currentOutputs: RunOutput[];
      artifactIds: string[];
    }
  >;
}
export interface NotebookRuntime {
  epoch(
    actor: string,
    projectId: string,
    notebookId: string,
  ): Promise<string | null>;
  invalidate(
    actor: string,
    projectId: string,
    notebookId: string,
    epoch: string,
  ): Promise<void>;
}
export interface NotebookSource {
  notebookId: string;
  cellId: string;
  revision: number;
  source: string;
  language: "python" | "r";
  sharing: SharedVariable[];
}
const jsonObject = z.record(z.string(), z.json());
const sourceSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((source) =>
    typeof source === "string" ? source : source.join(""),
  )
  .refine((source) => Buffer.byteLength(source) <= 65536);
const commonCell = {
  id: cellIdSchema.optional(),
  source: sourceSchema,
  metadata: jsonObject,
};
const documentSchema = z
  .object({
    nbformat: z.literal(4),
    nbformat_minor: z.number().int().min(0).max(5),
    metadata: jsonObject,
    cells: z
      .array(
        z.discriminatedUnion("cell_type", [
          z
            .object({
              ...commonCell,
              cell_type: z.literal("code"),
              outputs: z.array(z.json()),
              execution_count: z.number().int().nonnegative().nullable(),
            })
            .strict(),
          z
            .object({
              ...commonCell,
              cell_type: z.enum(["markdown", "raw"]),
              attachments: z.record(z.string(), jsonObject).optional(),
            })
            .strict(),
        ]),
      )
      .max(100),
  })
  .strict();
const settingsSchema = z
  .object({ language: z.enum(["python", "r"]), sharing: sharingSchema })
  .strict();
const nameSchema = z.string().trim().min(1).max(120);
const createSchema = z
  .object({
    name: nameSchema,
    document: z.unknown(),
    editorName: historyEditorSchema.optional(),
    reason: historyReasonSchema.optional(),
  })
  .strict();
const saveSchema = z
  .object({
    revision: z.number().int().positive(),
    name: nameSchema.optional(),
    document: z.unknown(),
    editorName: historyEditorSchema.optional(),
    reason: historyReasonSchema.optional(),
  })
  .strict();
const patchSchema = z
  .object({
    revision: z.number().int().positive(),
    name: nameSchema.optional(),
    cellId: cellIdSchema.optional(),
    source: sourceSchema.optional(),
    editorName: historyEditorSchema.optional(),
    reason: historyReasonSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.cellId === undefined) === (value.source === undefined) &&
      (value.name !== undefined || value.source !== undefined),
  );
function importedBudget(wireBytes: number) {
  // Explicit magic descriptors and inert histories expand internally, not on the wire.
  return wireBytes * 32 + 65536;
}
const fields = `n.id,l.actor,l.project_id AS "projectId",l.chat_id AS "chatId",n.name,n.revision`;
const from = "FROM notebooks n JOIN notebook_links l ON l.id=n.id";
/** @id CODE-NOTE-LABNOTE-INTEGRITY @implements REQ-NOTE-006 */
export async function validateProjectLabNotes(client: pg.Client) {
  const invalid = await client.query(`
    SELECT p.id FROM projects p
    LEFT JOIN project_lab_notes j ON j.project_id=p.id
    LEFT JOIN notebook_links l ON l.id=j.notebook_id
      AND l.project_id=p.id AND l.actor=p.actor AND l.chat_id=p.chat_id
    LEFT JOIN notebooks n ON n.id=l.id
    WHERE j.notebook_id IS NULL OR j.actor<>p.actor OR n.id IS NULL
      OR NOT project_lab_note_markdown(n.document)
      OR (SELECT count(*) FROM notebook_versions v
          WHERE v.notebook_id=n.id AND v.project_id=p.id AND v.actor=p.actor
            AND v.revision=n.revision
            AND v.content=jsonb_build_object('name',n.name,'document',notebook_source_document(n.document)))<>1
      OR EXISTS(SELECT 1 FROM notebook_versions v WHERE v.notebook_id=n.id
          AND (NOT project_lab_note_markdown(v.content->'document')
            OR v.sha256<>encode(sha256(convert_to(v.content::text,'UTF8')),'hex')))
    LIMIT 1
  `);
  if (invalid.rowCount)
    throw new ServiceError(503, "PROJECT_LAB_NOTE_INTEGRITY_INVALID");
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof RangeError)
      throw new ServiceError(400, "INVALID_NOTEBOOK");
    throw error;
  }
}
function settings(cell: CodeCell) {
  return parse(settingsSchema, cell.metadata.aira);
}
function normalizeDocument(
  input: unknown,
  ids: { id: string; projectId: string; chatId: string },
  maximumBytes = 12 * 1024 * 1024,
): NotebookDocument {
  const document = parse(documentSchema, input);
  const association = parse(
    z
      .object({
        project_id: z.uuid().optional(),
        chat_id: z.uuid().optional(),
        notebook_id: z.uuid().optional(),
      })
      .strict(),
    document.metadata.aira === undefined ? {} : document.metadata.aira,
  );
  if (
    (association.project_id &&
      association.project_id.toLowerCase() !== ids.projectId) ||
    (association.chat_id && association.chat_id.toLowerCase() !== ids.chatId) ||
    (association.notebook_id &&
      association.notebook_id.toLowerCase() !== ids.id)
  )
    throw new ServiceError(404, "NOTEBOOK_ASSOCIATION_NOT_FOUND");
  const kernel = document.metadata.kernelspec;
  const info = document.metadata.language_info;
  const specification =
    kernel === undefined
      ? undefined
      : parse(
          z
            .object({
              name: z.string(),
              display_name: z.string(),
              language: z.string().optional(),
            })
            .passthrough(),
          kernel,
        );
  const declaredInfo =
    info === undefined
      ? undefined
      : parse(z.object({ name: z.string() }).passthrough(), info).name;
  const declaredKernel = specification?.language;
  const kernelName = specification?.name;
  const namedKernel =
    kernelName === "ir"
      ? "r"
      : kernelName === "python" || kernelName === "python3"
        ? "python"
        : undefined;
  const languages = [declaredInfo, declaredKernel, namedKernel]
    .filter((candidate): candidate is string => candidate !== undefined)
    .map((candidate) =>
      parse(z.enum(["python", "r"]), candidate.toLowerCase()),
    );
  if (new Set(languages).size > 1)
    throw new ServiceError(400, "AMBIGUOUS_NOTEBOOK_LANGUAGE");
  const language: "python" | "r" = languages[0] ?? "python";
  if (!languages.length && specification)
    throw new ServiceError(400, "UNKNOWN_NOTEBOOK_LANGUAGE");
  const seen = new Set<string>();
  const cells: NotebookDocument["cells"] = document.cells.map((cell) => {
    const id = cell.id ?? randomUUID();
    if (seen.has(id)) throw new ServiceError(400, "DUPLICATE_CELL_ID");
    seen.add(id);
    if (cell.cell_type !== "code") return { ...cell, id };
    const declared = parse(
      settingsSchema.partial(),
      cell.metadata.aira === undefined ? {} : cell.metadata.aira,
    );
    const selected = {
      language: declared.language ?? language,
      sharing: declared.sharing ?? [],
    };
    const sharing = selected.sharing.map((entry) => {
      const value: Record<string, JsonValue> = {
        name: entry.name,
        direction: entry.direction,
      };
      if (entry.family !== undefined) value.family = entry.family;
      return value;
    });
    const outputs = parse(
      outputsSchema,
      cell.outputs.map((output) => {
        if (
          output &&
          typeof output === "object" &&
          !Array.isArray(output) &&
          output.output_type === "stream" &&
          Array.isArray(output.text) &&
          output.text.every((part) => typeof part === "string")
        ) {
          return { ...output, text: output.text.join("") };
        }
        return output;
      }),
    );
    return {
      ...cell,
      id,
      outputs,
      metadata: {
        ...cell.metadata,
        aira: { language: selected.language, sharing },
      },
    };
  });
  const result: NotebookDocument = {
    nbformat: 4,
    nbformat_minor: 5,
    cells,
    metadata: {
      ...document.metadata,
      aira: {
        project_id: ids.projectId,
        chat_id: ids.chatId,
        notebook_id: ids.id,
      },
    },
  };
  encodedJson(result, maximumBytes, "INVALID_NOTEBOOK", "NOTEBOOK_TOO_LARGE");
  const displayBytes = cells.reduce(
    (sum, cell) =>
      sum +
      Buffer.byteLength(
        JSON.stringify(cell.cell_type === "code" ? cell.outputs : []),
      ) +
      Buffer.byteLength(
        JSON.stringify(
          cell.cell_type === "code" ? {} : (cell.attachments ?? {}),
        ),
      ),
    0,
  );
  if (displayBytes > 2 * 1024 * 1024)
    throw new ServiceError(413, "NOTEBOOK_DISPLAY_TOO_LARGE");
  return result;
}
/** @id CODE-NOTE-STORE @implements REQ-NOTE-001 REQ-NOTE-002 REQ-NOTE-003 REQ-NH-001 REQ-NH-004 REQ-NH-006 */
export class Notebooks {
  private readonly pool: pg.Pool;
  readonly versions: NotebookVersions;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly operations: Operations,
    private readonly provenance: Provenance,
    private readonly runtime: NotebookRuntime,
    state: string,
    credentials: Credentials,
    historyOptions: NotebookVersionsOptions = {},
  ) {
    this.pool = new pg.Pool({
      ...databaseConfig(state, credentials, "application"),
      max: 4,
    });
    this.pool.on("error", () =>
      console.error("NOTEBOOK_DATABASE_CONNECTION_LOST"),
    );
    this.versions = new NotebookVersions(
      operations,
      this.pool,
      state,
      credentials,
      {
        save: (client, actor, project, id, input, event) =>
          this.saveInTransaction(client, actor, project, id, input, event),
        read: (actor, project, id) => this.get(actor, project, id),
      },
      historyOptions,
    );
  }
  private async read(
    client: pg.Pool | pg.Client,
    actor: string,
    projectId: string,
    id: string,
    lock = false,
  ): Promise<StoredNotebook> {
    validId(id);
    const result = await client.query<StoredNotebook>(
      `SELECT ${fields},n.document ${from} WHERE n.id=$1 AND l.actor=$2 AND l.project_id=$3 ${lock ? "FOR UPDATE OF n" : ""}`,
      [id, actor, projectId],
    );
    if (result.rowCount !== 1)
      throw new ServiceError(404, "NOTEBOOK_NOT_FOUND");
    return result.rows[0];
  }
  async create(
    actor: string,
    projectId: string,
    input: unknown,
  ): Promise<Notebook> {
    const notebook = await this.operations.write((client) =>
      this.createInTransaction(client, actor, projectId, input),
    );
    return this.get(actor, projectId, notebook.id);
  }
  async createInTransaction(
    client: pg.Client,
    actor: string,
    projectId: string,
    input: unknown,
    event?: VersionMetadata,
  ): Promise<StoredNotebook> {
    return this.insert(
      client,
      actor,
      projectId,
      input,
      12 * 1024 * 1024,
      event,
    );
  }
  private async insert(
    client: pg.Client,
    actor: string,
    projectId: string,
    input: unknown,
    maximumBytes: number,
    event?: VersionMetadata,
  ): Promise<StoredNotebook> {
    this.operations.assertTransaction(client);
    const project = await ownedProject(client, actor, projectId, true);
    if (project.status !== "active")
      throw new ServiceError(409, "PROJECT_ARCHIVED");
    const value = parse(createSchema, input),
      id = randomUUID();
    const document = normalizeDocument(
      value.document,
      {
        id,
        projectId: project.id,
        chatId: project.chatId,
      },
      maximumBytes,
    );
    await client.query(
      "INSERT INTO notebook_links(id,actor,project_id,chat_id) VALUES($1,$2,$3,$4)",
      [id, actor, projectId, project.chatId],
    );
    await client.query(
      "INSERT INTO notebooks(id,name,document) VALUES($1,$2,$3::jsonb)",
      [id, value.name, JSON.stringify(document)],
    );
    const stored = await this.read(client, actor, projectId, id);
    await this.versions.record(
      client,
      stored,
      event ?? {
        origin: "create",
        editor: value.editorName ?? "Local user (self-declared)",
        reason: value.reason,
      },
    );
    return stored;
  }
  /** @id CODE-XCH-IMPORT @implements REQ-XCH-001 */
  async createImported(
    actor: string,
    projectId: string,
    name: string,
    document: NotebookDocument,
    wire: Uint8Array,
  ): Promise<Notebook> {
    if (!wire.byteLength) throw new ServiceError(400, "NOTEBOOK_BODY_REQUIRED");
    if (wire.byteLength > 12 * 1024 * 1024)
      throw new ServiceError(413, "EXCHANGE_BODY_TOO_LARGE");
    const maximumBytes = importedBudget(wire.byteLength);
    const notebook = await this.operations.write(async (client) => {
      const notebook = await this.insert(
        client,
        actor,
        projectId,
        { name, document },
        maximumBytes,
        { origin: "import", editor: null },
      );
      await client.query(
        "INSERT INTO notebook_imports(notebook_id,wire_bytes,original_document) VALUES($1,$2,$3::jsonb)",
        [
          notebook.id,
          wire.byteLength,
          new TextDecoder("utf-8", { fatal: true }).decode(wire),
        ],
      );
      return notebook;
    });
    return this.get(actor, projectId, notebook.id);
  }
  /** @id CODE-XCH-PATCH @implements REQ-XCH-001 */
  async patch(
    actor: string,
    projectId: string,
    id: string,
    input: unknown,
  ): Promise<Notebook> {
    const value = parse(patchSchema, input);
    await this.operations.write(async (client) => {
      await ownedProject(client, actor, projectId, true);
      const notebook = await this.read(client, actor, projectId, id, true);
      if (value.cellId !== undefined && value.source !== undefined) {
        const cell = notebook.document.cells.find(
          (cell) => cell.id === value.cellId,
        );
        if (!cell) throw new ServiceError(404, "CELL_NOT_FOUND");
        cell.source = value.source;
      }
      await this.saveInTransaction(
        client,
        actor,
        projectId,
        id,
        {
          revision: value.revision,
          name: value.name,
          document: notebook.document,
          editorName: value.editorName,
          reason: value.reason,
        },
        {
          origin: "patch",
          editor: value.editorName ?? "Local user (self-declared)",
          reason: value.reason,
        },
      );
    });
    return this.get(actor, projectId, id);
  }
  async imported(actor: string, projectId: string, id: string) {
    await ownedProject(this.pool, actor, projectId);
    await this.read(this.pool, actor, projectId, id);
    const result = await this.pool.query<{ document: JsonValue }>(
      "SELECT original_document AS document FROM notebook_imports WHERE notebook_id=$1",
      [id],
    );
    return result.rowCount
      ? {
          kind: "imported",
          executed: false,
          native_run_id: null,
          document: result.rows[0].document,
        }
      : null;
  }
  private async artifacts(actor: string, projectId: string, id: string) {
    const result = await this.pool.query<{ id: string; runId: string }>(
      `SELECT id,run_id AS "runId" FROM file_versions WHERE actor=$1 AND project_id=$2 AND notebook_id=$3 AND origin_kind='run' ORDER BY created_at,id`,
      [actor, projectId, id],
    );
    const grouped = new Map<string, string[]>();
    for (const file of result.rows) {
      const ids = grouped.get(file.runId) ?? [];
      ids.push(file.id);
      grouped.set(file.runId, ids);
    }
    return grouped;
  }
  async get(actor: string, projectId: string, id: string): Promise<Notebook> {
    await ownedProject(this.pool, actor, projectId);
    const notebook = await this.read(this.pool, actor, projectId, id);
    const links = await this.pool.query<{ cellId: string; runId: string }>(
      `SELECT cell_id AS "cellId",run_id AS "runId" FROM notebook_cell_results WHERE notebook_id=$1`,
      [id],
    );
    const results: Notebook["results"] = {};
    const epoch = links.rowCount
      ? await this.runtime.epoch(actor, notebook.projectId, notebook.id)
      : null;
    const artifacts = await this.artifacts(actor, projectId, id);
    for (const link of links.rows) {
      const cell = notebook.document.cells.find((c) => c.id === link.cellId);
      if (!cell || cell.cell_type !== "code") continue;
      const run = await this.provenance.get(actor, projectId, link.runId);
      const projection = projectRun(run, {
        id: cell.id,
        revision: notebook.revision,
        source: cell.source,
        ...settings(cell),
        kernelEpoch: epoch,
      });
      cell.outputs = projection.currentOutputs;
      cell.execution_count = null;
      for (const output of cell.outputs)
        if (
          output.output_type === "execute_result" &&
          output.execution_count !== null
        )
          cell.execution_count = output.execution_count;
      results[cell.id] = {
        ...projection,
        runId: run.id,
        status: run.status,
        artifactIds: artifacts.get(run.id) ?? [],
      };
    }
    return { ...notebook, results };
  }
  async list(
    actor: string,
    projectId: string,
  ): Promise<Omit<StoredNotebook, "document">[]> {
    await ownedProject(this.pool, actor, projectId);
    return (
      await this.pool.query<Omit<StoredNotebook, "document">>(
        `SELECT ${fields} ${from} WHERE l.actor=$1 AND l.project_id=$2
          AND NOT EXISTS(SELECT 1 FROM project_lab_notes j WHERE j.notebook_id=n.id)
          ORDER BY n.created_at,n.id`,
        [actor, projectId],
      )
    ).rows;
  }
  /** @id CODE-NOTE-LABNOTE-READ @implements REQ-NOTE-004 */
  async labNote(actor: string, projectId: string): Promise<Notebook> {
    await ownedProject(this.pool, actor, projectId);
    const result = await this.pool.query<{ id: string }>(
      "SELECT notebook_id AS id FROM project_lab_notes WHERE project_id=$1 AND actor=$2",
      [projectId, actor],
    );
    if (result.rowCount !== 1)
      throw new ServiceError(503, "PROJECT_LAB_NOTE_MISSING");
    return this.get(actor, projectId, result.rows[0].id);
  }
  async save(
    actor: string,
    projectId: string,
    id: string,
    input: unknown,
  ): Promise<Notebook> {
    await this.operations.write((client) =>
      this.saveInTransaction(client, actor, projectId, id, input),
    );
    return this.get(actor, projectId, id);
  }
  async saveInTransaction(
    client: pg.Client,
    actor: string,
    projectId: string,
    id: string,
    input: unknown,
    event?: VersionMetadata,
  ): Promise<StoredNotebook> {
    this.operations.assertTransaction(client);
    const project = await ownedProject(client, actor, projectId, true);
    if (project.status !== "active")
      throw new ServiceError(409, "PROJECT_ARCHIVED");
    const value = parse(saveSchema, input),
      notebook = await this.read(client, actor, projectId, id, true);
    if (value.revision !== notebook.revision)
      throw new ServiceError(409, "STALE_NOTEBOOK_REVISION");
    if (notebook.revision === 2147483647)
      throw new ServiceError(409, "NOTEBOOK_REVISION_EXHAUSTED");
    const imported = await client.query<{ wireBytes: number }>(
      'SELECT wire_bytes AS "wireBytes" FROM notebook_imports WHERE notebook_id=$1',
      [id],
    );
    const maximumBytes = imported.rowCount
      ? importedBudget(imported.rows[0].wireBytes)
      : 12 * 1024 * 1024;
    const document = normalizeDocument(value.document, notebook, maximumBytes);
    const journal = await client.query(
      "SELECT 1 FROM project_lab_notes WHERE notebook_id=$1",
      [id],
    );
    if (
      journal.rowCount &&
      document.cells.some((cell) => cell.cell_type !== "markdown")
    )
      throw new ServiceError(400, "PROJECT_LAB_NOTE_MARKDOWN_ONLY");
    await client.query(
      "UPDATE notebooks SET name=$2,revision=revision+1,document=$3::jsonb WHERE id=$1",
      [id, value.name ?? notebook.name, JSON.stringify(document)],
    );
    const stored = await this.read(client, actor, projectId, id);
    await this.versions.record(
      client,
      stored,
      event ?? {
        origin: "save",
        editor: value.editorName ?? "Local user (self-declared)",
        reason: value.reason,
      },
    );
    return stored;
  }
  async source(
    actor: string,
    projectId: string,
    id: string,
    cellId: string,
  ): Promise<NotebookSource> {
    await ownedProject(this.pool, actor, projectId);
    const notebook = await this.read(this.pool, actor, projectId, id);
    const cell = notebook.document.cells.find((c) => c.id === cellId);
    if (!cell) throw new ServiceError(404, "CELL_NOT_FOUND");
    if (cell.cell_type !== "code")
      throw new ServiceError(400, "CELL_NOT_EXECUTABLE");
    return {
      notebookId: notebook.id,
      cellId,
      revision: notebook.revision,
      source: cell.source,
      ...settings(cell),
    };
  }
  async completeRun(
    actor: string,
    projectId: string,
    id: string,
    runId: string,
    input: Parameters<Provenance["finish"]>[3],
  ): Promise<Notebook> {
    const run = await this.provenance.finish(
      actor,
      projectId,
      runId,
      input,
      id,
    );
    const stale = await this.operations.write(async (client) => {
      await ownedProject(client, actor, projectId);
      const notebook = await this.read(client, actor, projectId, id, true);
      const cell = notebook.document.cells.find((c) => c.id === run.cellId);
      if (
        !cell ||
        cell.cell_type !== "code" ||
        projectRun(run, {
          id: cell.id,
          revision: notebook.revision,
          source: cell.source,
          ...settings(cell),
          kernelEpoch: run.kernelEpoch,
        }).stale
      )
        return true;
      await client.query(
        `INSERT INTO notebook_cell_results(notebook_id,cell_id,run_id) VALUES($1,$2,$3)
         ON CONFLICT(notebook_id,cell_id) DO UPDATE SET run_id=excluded.run_id`,
        [id, cell.id, run.id],
      );
      return false;
    });
    if (stale) {
      await this.runtime.invalidate(
        actor,
        run.projectId,
        run.notebookId,
        run.kernelEpoch,
      );
      throw new ServiceError(409, "STALE_RUN_PROJECTION");
    }
    return this.get(actor, projectId, id);
  }
  async history(
    actor: string,
    projectId: string,
    id: string,
  ): Promise<(CapturedRun & { artifactIds: string[] })[]> {
    await ownedProject(this.pool, actor, projectId);
    await this.read(this.pool, actor, projectId, id);
    const [runs, artifacts] = await Promise.all([
      this.provenance.history(actor, projectId, id),
      this.artifacts(actor, projectId, id),
    ]);
    return runs.map((run) => ({
      ...run,
      artifactIds: artifacts.get(run.id) ?? [],
    }));
  }
  close() {
    return (this.closing ??= (async () => {
      try {
        await this.versions.close();
      } finally {
        await this.pool.end();
      }
    })());
  }
}
