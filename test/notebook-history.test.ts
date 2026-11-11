import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from "node:timers/promises";
import { z } from "zod";
import type pg from "pg";
import { testDatabase } from "./helpers/database";
import { connectDatabase } from "../src/server/database";
import { Operations } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { Files } from "../src/server/files";
import { FileStorage, storageDirectory } from "../src/server/file-storage";
import { Provenance } from "../src/server/provenance";
import {
  Notebooks,
  type Notebook,
  type NotebookDocument,
  type NotebookRuntime,
} from "../src/server/notebooks";
import { notebookRoutes } from "../src/server/notebook-routes";
import { Proposals } from "../src/server/proposals";
import { Exchange } from "../src/server/exchange";
import { ServiceError } from "../src/server/http";
import { loadCredentials } from "../src/server/credentials";
import { readDatabaseIdentity } from "../src/server/db-container";
import { removeOwned } from "../src/server/owned-containers";
import { migrate } from "../scripts/migrate";
import { backup } from "../scripts/backup";
import { restoreValidation } from "../scripts/restore-validation";
import { NotebookGit } from "../src/server/notebook-git";

const execute = promisify(execFile);
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const status = (expected: number) => (error: unknown) =>
  error instanceof ServiceError && error.status === expected;
const sqlState = (expected: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === expected;
const gitState = z.enum(["pending", "exported", "error", "blocked"]);
const gitStatus = z.object({
  generation: z.uuid().nullable(),
  status: gitState,
  errorCode: z.string().nullable(),
  rebuilt: z.boolean(),
});
const summary = z.object({
  id: z.string().regex(/^[1-9][0-9]*$/),
  revision: z.number().int().positive(),
  name: z.string(),
  origin: z.string(),
  editor: z.string().nullable(),
  reason: z.string().nullable(),
  proposalId: z.uuid().nullable(),
  restoredFrom: z.number().int().positive().nullable(),
  createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  git: z.object({
    state: gitState,
    commit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
    errorCode: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
  }),
});
const pageSchema = z.object({
  versions: z.array(summary),
  nextCursor: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .nullable(),
  git: gitStatus,
});
type Version = z.infer<typeof summary>;
const sourceCell = z.discriminatedUnion("cell_type", [
  z
    .object({
      id: z.string(),
      cell_type: z.literal("code"),
      source: z.string(),
      metadata: z.record(z.string(), z.json()),
      outputs: z.array(z.never()),
      execution_count: z.null(),
    })
    .strict(),
  z
    .object({
      id: z.string(),
      cell_type: z.enum(["markdown", "raw"]),
      source: z.string(),
      metadata: z.record(z.string(), z.json()),
      attachments: z
        .record(z.string(), z.record(z.string(), z.json()))
        .optional(),
    })
    .strict(),
]);
const sourceDocument = z
  .object({
    nbformat: z.literal(4),
    nbformat_minor: z.number().int().nonnegative(),
    metadata: z.record(z.string(), z.json()),
    cells: z.array(sourceCell),
  })
  .strict();

function document(): NotebookDocument {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { title: "保存済み研究", custom: { keep: true } },
    cells: [
      {
        id: "code-a",
        cell_type: "code",
        source: "x = 17",
        metadata: { aira: { language: "python", sharing: [] }, tags: ["keep"] },
        outputs: [
          { output_type: "stream", name: "stdout", text: "OLD OUTPUT" },
        ],
        execution_count: 7,
      },
      {
        id: "code-b",
        cell_type: "code",
        source: "print(2L)",
        metadata: { aira: { language: "r", sharing: [] } },
        outputs: [],
        execution_count: null,
      },
      {
        id: "raw-a",
        cell_type: "raw",
        source: "literal raw",
        metadata: { custom: "retained" },
        attachments: { "data.txt": { "text/plain": "aGVsbG8=" } },
      },
      {
        id: "markdown-a",
        cell_type: "markdown",
        source:
          "---\naira:\n  created_at: 2020-01-02T03:04:05.000Z\n  updated_at: 2020-01-02T03:04:05.000Z\n  editor_identity: self-declared\n  editor_history:\n    - editor: Historic Editor\n      edited_at: 2020-01-02T03:04:05.000Z\n---\n# Historical YAML\n<script>literal()</script>",
        metadata: {},
        attachments: { "plot.png": { "image/png": "aGVsbG8=" } },
      },
    ],
  };
}
function sourceOnly(input: NotebookDocument): NotebookDocument {
  const result = structuredClone(input);
  for (const cell of result.cells)
    if (cell.cell_type === "code") {
      cell.outputs = [];
      cell.execution_count = null;
    }
  return result;
}

// Recreate only this newly allocated test database, never a configured app state.
async function legacySchema(db: Awaited<ReturnType<typeof testDatabase>>) {
  assert.equal(
    resolve(db.state).startsWith(resolve(".scratch") + "/db-"),
    true,
  );
  const bootstrap = await connectDatabase(
    db.state,
    db.credentials,
    "bootstrap",
  );
  try {
    await bootstrap.query(
      "DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION aira_migration; GRANT USAGE ON SCHEMA public TO aira_application",
    );
  } finally {
    await bootstrap.end();
  }
  const client = await connectDatabase(db.state, db.credentials, "migration");
  try {
    await client.query("BEGIN");
    await client.query(
      "CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
    );
    const names = (await readdir("src/server/migrations"))
      .filter((name) => /^\d{3}-[a-z-]+\.sql$/.test(name) && name < "013-")
      .sort();
    assert.ok(names.includes("012-project-navigation.sql"));
    for (const name of names) {
      await client.query(
        await readFile(join("src/server/migrations", name), "utf8"),
      );
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [
        name.slice(0, -4),
      ]);
      if (name === "001-operations.sql")
        await client.query(
          "GRANT SELECT, INSERT, UPDATE, DELETE ON writer_control,jobs,grants,operation_containers TO aira_application",
        );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function fixture(t: TestContext, legacy = false) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "HISTORY_TEST_CLEANUP");
  });
  const db = await testDatabase();
  cleanup.push(() => db.cleanup());
  if (legacy) await legacySchema(db);
  const operations = new Operations(db.state, db.credentials);
  cleanup.push(() => operations.close());
  await operations.acquire();
  const sessions = new Sessions(operations, db.state, db.credentials);
  cleanup.push(() => sessions.close());
  const project = await sessions.createProject("local", "History fixture");
  const foreign = await sessions.createProject("other", "Private fixture");
  const storage = new FileStorage(await storageDirectory(db.state));
  await storage.initialize();
  const files = new Files(operations, storage, db.state, db.credentials);
  cleanup.push(() => files.close());
  const provenance = new Provenance(
    operations,
    files,
    db.state,
    db.credentials,
  );
  cleanup.push(() => provenance.close());
  const infrastructure = new Set(await readdir(db.state));
  const runtime: NotebookRuntime = {
    async epoch() {
      return null;
    },
    async invalidate() {
      assert.fail("history must not execute or invalidate a research kernel");
    },
  };
  const notebooks = new Notebooks(
    operations,
    provenance,
    runtime,
    db.state,
    db.credentials,
  );
  cleanup.push(() => notebooks.close());
  const proposals = new Proposals(
    operations,
    notebooks,
    db.state,
    db.credentials,
  );
  cleanup.push(() => proposals.close());
  const admin = await connectDatabase(db.state, db.credentials, "migration");
  cleanup.push(() => admin.end());
  const application = await connectDatabase(
    db.state,
    db.credentials,
    "application",
  );
  cleanup.push(() => application.end());
  let notebook: Notebook;
  if (legacy) {
    const id = randomUUID();
    const body = document();
    body.metadata.aira = {
      project_id: project.id,
      chat_id: project.chatId,
      notebook_id: id,
    };
    await operations.write(async (client) => {
      await client.query(
        "INSERT INTO notebook_links(id,actor,project_id,chat_id) VALUES($1,'local',$2,$3)",
        [id, project.id, project.chatId],
      );
      await client.query(
        "INSERT INTO notebooks(id,name,revision,document) VALUES($1,'Legacy revision seven',7,$2::jsonb)",
        [id, JSON.stringify(body)],
      );
    });
    notebook = await notebooks.get("local", project.id, id);
  } else {
    notebook = await notebooks.create("local", project.id, {
      name: "Original notebook",
      document: document(),
    });
  }
  return {
    ...db,
    cleanup,
    operations,
    sessions,
    project,
    foreign,
    storage,
    files,
    provenance,
    runtime,
    notebooks,
    proposals,
    admin,
    application,
    notebook,
    infrastructure,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function request(
  f: Pick<Fixture, "notebooks" | "project" | "notebook">,
  suffix = "/versions",
  method = "GET",
  body?: unknown,
  project = f.project.id,
  notebook = f.notebook.id,
) {
  return notebookRoutes(f.notebooks)(
    new Request(
      `http://localhost/api/projects/${project}/notebooks/${notebook}${suffix}`,
      {
        method,
        headers: {
          Host: "localhost",
          Origin: "http://localhost",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    ),
  );
}
async function page(f: Parameters<typeof request>[0], query = "") {
  const response = await request(f, "/versions" + query);
  assert.equal(
    response.status,
    200,
    "saved-version HTTP list must exist and return owned committed versions",
  );
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return pageSchema.parse(await response.json());
}
async function detail(f: Parameters<typeof request>[0], revision: number) {
  const response = await request(f, `/versions/${revision}`);
  assert.equal(response.status, 200);
  const value = z
    .object({
      version: summary,
      name: z.string(),
      document: sourceDocument,
    })
    .parse(await response.json());
  assert.equal(value.version.revision, revision);
  return value;
}
async function exportsTable(client: pg.Client) {
  const tables = await client.query<{ name: string }>(`
    SELECT DISTINCT c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_constraint f ON f.conrelid=c.oid AND f.contype='f'
    WHERE n.nspname='public' AND f.confrelid='notebook_versions'::regclass
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='attempts')
  `);
  assert.equal(
    tables.rowCount,
    1,
    "one separate mutable version export outbox is required",
  );
  const name = tables.rows[0].name;
  assert.match(name, /^[a-z_][a-z0-9_]*$/);
  return `"${name}"`;
}
async function eventCounts(f: Fixture) {
  const table = await exportsTable(f.admin);
  return (
    await f.admin.query<{ versions: number; intents: number }>(`
    SELECT (SELECT count(*)::integer FROM notebook_versions) AS versions,
      (SELECT count(*)::integer FROM ${table}) AS intents
  `)
  ).rows[0];
}
async function assertCanonical(
  f: Fixture,
  version: Version,
  notebook: Notebook,
) {
  const stored = await f.admin.query<{
    content: { name: string; document: NotebookDocument };
    canonical: string;
    sha256: string;
    database_sha256: string;
    notebook_id: string;
    project_id: string;
    actor: string;
  }>(
    "SELECT content,content::text AS canonical,sha256,encode(sha256(convert_to(content::text,'UTF8')),'hex') AS database_sha256,notebook_id,project_id,actor FROM notebook_versions WHERE id=$1",
    [version.id],
  );
  assert.equal(stored.rowCount, 1);
  const row = stored.rows[0];
  assert.equal(row.notebook_id, notebook.id);
  assert.equal(row.project_id, notebook.projectId);
  assert.equal(row.actor, notebook.actor);
  assert.deepEqual(row.content, {
    name: notebook.name,
    document: sourceOnly(notebook.document),
  });
  assert.equal(row.sha256, digest(row.canonical));
  assert.equal(row.sha256, row.database_sha256);
  assert.equal(version.sha256, row.sha256);
}
async function runRecord(f: Fixture) {
  const source = await f.notebooks.source(
    "local",
    f.project.id,
    f.notebook.id,
    "code-a",
  );
  const fingerprint = digest(randomUUID());
  const grantId = await f.operations.grant("local", "execution", fingerprint);
  const job = await f.operations.admit(
    {
      actor: "local",
      requestId: randomUUID(),
      purpose: "execution",
      fingerprint,
      grantId,
    },
    f.project.id,
  );
  const run = await f.provenance.capture("local", f.project.id, {
    ...source,
    jobId: job.id,
    inputs: [],
    kernelEpoch: randomUUID(),
    environment: {
      imageDigest: "sha256:" + "a".repeat(64),
      python: "synthetic-producer",
      r: "synthetic-producer",
      packages: {},
    },
  });
  await f.operations.dispatch("local", job.id);
  await f.operations.observeStarted("local", job.id);
  await f.notebooks.completeRun("local", f.project.id, f.notebook.id, run.id, {
    status: "completed",
    outputs: [
      { output_type: "stream", name: "stdout", text: "historical result" },
    ],
    artifacts: [],
  });
  return run.id;
}
async function researchRecords(f: Fixture) {
  return (
    await f.admin.query(`
    SELECT (SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM jobs j) AS jobs,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM runs r) AS runs,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY run_id) FROM run_results r) AS results,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY notebook_id,cell_id) FROM notebook_cell_results r) AS projections,
      (SELECT jsonb_agg(to_jsonb(f) ORDER BY id) FROM file_versions f) AS files,
      (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM chat_turns t) AS turns
  `)
  ).rows[0];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** @id TEST-NH-001 @verifies REQ-NH-001 */
test(
  "TEST-NH-001 all committed mutation paths append one canonical source event and intent; failures/rollback append neither",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t);
    const initial = await page(f);
    assert.deepEqual(
      initial.versions.map((v) => [v.revision, v.origin]),
      [[1, "create"]],
    );

    assert.equal(initial.versions[0].proposalId, null);
    assert.equal(initial.versions[0].git.state, "pending");
    assert.equal(initial.versions[0].git.commit, null);
    assert.equal(initial.versions[0].git.attempts, 0);
    await assertCanonical(f, initial.versions[0], f.notebook);
    assert.deepEqual(await eventCounts(f), { versions: 3, intents: 3 });
    const past = await detail(f, 1);
    assert.deepEqual(past.document, sourceOnly(f.notebook.document));

    const changed = structuredClone(f.notebook.document);
    changed.cells[0].source = "x = 23";
    let response = await request(f, "", "PUT", {
      revision: 1,
      name: "Renamed 日本語",
      document: changed,
      editorName: "Self-declared Alice",
      reason: "Correct measurement",
    });
    assert.equal(response.status, 200);
    let current = await f.notebooks.get("local", f.project.id, f.notebook.id);
    let versions = (await page(f)).versions;
    assert.equal(current.revision, 2);
    assert.deepEqual(
      [versions[0].origin, versions[0].editor, versions[0].reason],
      ["save", "Self-declared Alice", "Correct measurement"],
    );
    await assertCanonical(f, versions[0], current);
    for (const extra of [
      { editorName: "" },
      { editorName: "\n" },
      { editorName: 123 },
      { editorName: "x".repeat(121) },
      { reason: 7 },
      { origin: "baseline" },
      { proposalId: randomUUID() },
    ]) {
      response = await request(f, "", "PUT", {
        revision: 2,
        document: changed,
        ...extra,
      });
      assert.equal(response.status, 400, JSON.stringify(extra));
    }
    assert.equal(
      (
        await request(f, "", "PUT", {
          revision: 1,
          document: changed,
        })
      ).status,
      409,
    );
    assert.deepEqual(await eventCounts(f), { versions: 4, intents: 4 });
    assert.equal(
      (
        await request(f, "", "PATCH", {
          revision: 2,
          cellId: "code-a",
          source: "x = 31",
        })
      ).status,
      200,
    );
    current = await f.notebooks.get("local", f.project.id, f.notebook.id);
    versions = (await page(f)).versions;
    assert.equal(versions[0].origin, "patch");
    await assertCanonical(f, versions[0], current);
    current = await f.notebooks.save("local", f.project.id, current.id, {
      revision: 3,
      document: current.document,
    });
    assert.equal(
      current.revision,
      4,
      "unchanged saves retain ordinary revision increments",
    );
    versions = (await page(f)).versions;
    assert.equal(versions[0].origin, "save");
    assert.ok(
      versions[0].editor?.trim(),
      "raw API editor is explicitly self-declared local identity",
    );
    assert.equal(
      current.document.cells[3].source,
      past.document.cells[3].source,
      "unchanged YAML must not acquire fabricated editor entries",
    );
    assert.deepEqual(
      await detail(f, 1),
      past,
      "old saved content and metadata are immutable",
    );

    const beforeRollback = await eventCounts(f);
    const rollback = new Error("INTENTIONAL_NOTEBOOK_HISTORY_ROLLBACK");
    await assert.rejects(
      f.operations.write(async (client) => {
        await f.notebooks.saveInTransaction(
          client,
          "local",
          f.project.id,
          current.id,
          {
            revision: current.revision,
            name: "must roll back",
            document: changed,
          },
        );
        throw rollback;
      }),
      (error) => error === rollback,
    );
    await assert.rejects(
      f.operations.write(async (client) => {
        await f.notebooks.createInTransaction(client, "local", f.project.id, {
          name: "must not exist",
          document: document(),
        });
        throw rollback;
      }),
      (error) => error === rollback,
    );
    assert.deepEqual(await eventCounts(f), beforeRollback);
    assert.deepEqual(
      await f.notebooks.get("local", f.project.id, current.id),
      current,
    );
    await assert.rejects(
      f.notebooks.saveInTransaction(
        f.application,
        "local",
        f.project.id,
        current.id,
        { revision: current.revision, document: changed },
      ),
      status(503),
    );
    const table = await exportsTable(f.admin);
    await f.admin.query(`
      CREATE FUNCTION nh_reject_intent() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected export intent failure'; END $$;
      CREATE TRIGGER nh_reject_intent BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION nh_reject_intent()
    `);
    try {
      await assert.rejects(
        f.notebooks.save("local", f.project.id, current.id, {
          revision: current.revision,
          name: "must roll back with intent",
          document: changed,
        }),
        sqlState("P0001"),
      );
      assert.deepEqual(await eventCounts(f), beforeRollback);
      assert.deepEqual(
        await f.notebooks.get("local", f.project.id, current.id),
        current,
      );
    } finally {
      await f.admin.query(
        `DROP TRIGGER nh_reject_intent ON ${table}; DROP FUNCTION nh_reject_intent()`,
      );
    }

    const action = {
      kind: "change-cell",
      notebookId: current.id,
      revision: current.revision,
      cell: {
        id: "code-a",
        cell_type: "code",
        source: "x = 41",
        language: "r",
        sharing: [],
      },
    };
    const rejected = await f.proposals.propose("local", f.project.id, action);
    await f.proposals.reject("local", f.project.id, rejected.id);
    await assert.rejects(
      f.proposals.accept("local", f.project.id, rejected.id, {
        revision: current.revision,
      }),
      status(409),
    );
    const pending = await f.proposals.propose("local", f.project.id, action);
    const stale = await f.proposals.propose("local", f.project.id, action);
    assert.deepEqual(
      await eventCounts(f),
      beforeRollback,
      "pending/rejected proposals are inert",
    );
    await assert.rejects(
      f.proposals.accept("local", f.project.id, pending.id, {
        revision: current.revision - 1,
      }),
      status(409),
    );
    const accepted = await f.proposals.accept(
      "local",
      f.project.id,
      pending.id,
      {
        revision: current.revision,
      },
    );
    assert.equal(accepted.revision, 5);
    assert.deepEqual(
      await f.proposals.accept("local", f.project.id, pending.id, {
        revision: current.revision,
      }),
      accepted,
      "receipt retry must not record a duplicate event",
    );
    versions = (await page(f)).versions;
    assert.equal(versions.length, 5);
    assert.equal(versions[0].origin, "proposal");
    assert.equal(versions[0].proposalId, pending.id);
    assert.equal(
      versions[0].editor,
      null,
      "model proposal is not an authenticated human editor",
    );
    await assertCanonical(
      f,
      versions[0],
      await f.notebooks.get("local", f.project.id, current.id),
    );
    await assert.rejects(
      f.proposals.accept("local", f.project.id, stale.id, {
        revision: current.revision,
      }),
      status(409),
    );
    const failedProposal = await f.proposals.propose("local", f.project.id, {
      ...action,
      revision: 5,
    });
    const beforeProposalFailure = await eventCounts(f);
    await f.admin.query(`
      CREATE FUNCTION nh_reject_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.origin='proposal' THEN RAISE EXCEPTION 'injected proposal append failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER nh_reject_proposal BEFORE INSERT ON notebook_versions
      FOR EACH ROW EXECUTE FUNCTION nh_reject_proposal()
    `);
    try {
      await assert.rejects(
        f.proposals.accept("local", f.project.id, failedProposal.id, {
          revision: 5,
        }),
        sqlState("P0001"),
      );
      assert.deepEqual(await eventCounts(f), beforeProposalFailure);
      assert.equal(
        (await f.notebooks.get("local", f.project.id, current.id)).revision,
        5,
      );
      const failed = await f.proposals.get(
        "local",
        f.project.id,
        failedProposal.id,
      );
      assert.equal(failed.state, "pending");
      assert.equal(failed.receipt, null);
    } finally {
      await f.admin.query(
        "DROP TRIGGER nh_reject_proposal ON notebook_versions; DROP FUNCTION nh_reject_proposal()",
      );
    }

    const createProposal = await f.proposals.propose("local", f.project.id, {
      kind: "create-notebook",
      name: "AI proposed notebook",
      cells: [
        { id: "ai-markdown", cell_type: "markdown", source: "# Proposed" },
      ],
    });
    const createdReceipt = await f.proposals.accept(
      "local",
      f.project.id,
      createProposal.id,
      { revision: 0 },
    );
    const created = await f.notebooks.get(
      "local",
      f.project.id,
      createdReceipt.notebookId,
    );
    const proposalVersion = (await page({ ...f, notebook: created }))
      .versions[0];
    assert.equal(proposalVersion.origin, "proposal");
    assert.equal(proposalVersion.proposalId, createProposal.id);
    await assertCanonical(f, proposalVersion, created);

    const wire = Buffer.from(JSON.stringify(document()));
    const imported = await new Exchange(f.notebooks).import(
      "local",
      f.project.id,
      "Imported",
      wire,
    );
    const importedVersion = (await page({ ...f, notebook: imported }))
      .versions[0];
    assert.equal(importedVersion.origin, "import");
    await assertCanonical(f, importedVersion, imported);
    assert.deepEqual(
      (await detail({ ...f, notebook: imported }, 1)).document.cells[3],
      sourceOnly(imported.document).cells[3],
    );
    assert.equal(
      (await f.notebooks.imported("local", f.project.id, imported.id))
        ?.executed,
      false,
    );

    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((done) => {
      enter = done;
    });
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const first = f.operations.write(async (client) => {
      const saved = await f.notebooks.saveInTransaction(
        client,
        "local",
        f.project.id,
        current.id,
        {
          revision: 5,
          document: current.document,
        },
      );
      enter();
      await blocked;
      return saved;
    });
    await entered;
    let overtook = false;
    const second = f.notebooks
      .save("local", f.project.id, imported.id, {
        revision: 1,
        document: imported.document,
      })
      .then((saved) => {
        overtook = true;
        return saved;
      });
    try {
      await delay(50);
      assert.equal(
        overtook,
        false,
        "later writer must not overtake an allocated uncommitted event",
      );
    } finally {
      release();
    }
    await Promise.all([first, second]);
    const firstId = (await page(f)).versions[0].id;
    const secondId = (await page({ ...f, notebook: imported })).versions[0].id;
    assert.ok(BigInt(firstId) < BigInt(secondId));
    const counts = await eventCounts(f);
    assert.equal(counts.versions, 11);
    assert.equal(counts.intents, counts.versions);
    const duplicates = await f.admin.query(
      "SELECT notebook_id,revision FROM notebook_versions GROUP BY notebook_id,revision HAVING count(*)<>1",
    );
    assert.equal(duplicates.rowCount, 0);
  },
);

/** @id TEST-NH-002 @verifies REQ-NH-002 */
test(
  "TEST-NH-002 writer-fenced idempotent migration adds only an honest revision-seven baseline; history is append-only",
  { timeout: 180000 },
  async (t) => {
    const control = await fixture(t);
    await page(control);
    const f = await fixture(t, true);
    const runId = await runRecord(f);
    const original = await f.notebooks.get(
      "local",
      f.project.id,
      f.notebook.id,
    );
    const research = await researchRecords(f);
    const persisted = (
      await f.admin.query(
        "SELECT to_jsonb(n) AS notebook,to_jsonb(l) AS association FROM notebooks n JOIN notebook_links l USING(id) WHERE n.id=$1",
        [f.notebook.id],
      )
    ).rows[0];
    const before = Date.now();
    await assert.rejects(
      migrate(f.state, f.credentials),
      (error: unknown) => error instanceof ServiceError && error.status >= 409,
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT name FROM schema_migrations WHERE name='013-notebook-history'",
        )
      ).rowCount,
      0,
      "active writer rejection must not leave a migration receipt",
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT to_regclass('public.notebook_versions') AS relation",
        )
      ).rows[0].relation,
      null,
      "failed migration is atomic",
    );
    assert.deepEqual(
      await f.notebooks.get("local", f.project.id, f.notebook.id),
      original,
    );
    await f.operations.close();
    await migrate(f.state, f.credentials);
    await migrate(f.state, f.credentials);
    const versions = (await page(f)).versions;
    assert.equal(versions.length, 1);
    const baseline = versions[0];
    assert.equal(baseline.revision, 7);
    assert.equal(baseline.origin, "baseline");
    assert.equal(baseline.editor, null);
    assert.equal(baseline.proposalId, null);
    assert.equal(baseline.restoredFrom, null);
    assert.ok(Date.parse(baseline.createdAt) >= before);
    assert.ok(Date.parse(baseline.createdAt) <= Date.now());
    assert.deepEqual(
      await f.notebooks.get("local", f.project.id, f.notebook.id),
      original,
    );
    assert.deepEqual(await researchRecords(f), research);
    assert.deepEqual(
      (
        await f.admin.query(
          "SELECT to_jsonb(n) AS notebook,to_jsonb(l) AS association FROM notebooks n JOIN notebook_links l USING(id) WHERE n.id=$1",
          [f.notebook.id],
        )
      ).rows[0],
      persisted,
    );
    assert.equal(
      (await f.notebooks.history("local", f.project.id, f.notebook.id))[0].id,
      runId,
    );
    assert.deepEqual(
      (await detail(f, 7)).document,
      sourceOnly(original.document),
    );
    await assertCanonical(f, baseline, original);
    assert.deepEqual(await eventCounts(f), { versions: 3, intents: 3 });
    for (const revision of [1, 6, 8])
      assert.equal((await request(f, `/versions/${revision}`)).status, 404);
    await assert.rejects(
      f.application.query(
        "UPDATE notebook_versions SET origin='forged' WHERE notebook_id=$1",
        [original.id],
      ),
      sqlState("42501"),
    );
    await assert.rejects(
      f.application.query(
        "DELETE FROM notebook_versions WHERE notebook_id=$1",
        [original.id],
      ),
      sqlState("42501"),
    );
    await assert.rejects(
      f.application.query("TRUNCATE notebook_versions"),
      sqlState("42501"),
    );
    const privileges = (
      await f.application.query(`
      SELECT has_table_privilege(current_user,'notebook_versions','SELECT') AS read,
        has_table_privilege(current_user,'notebook_versions','INSERT') AS append,
        has_table_privilege(current_user,'notebook_versions','UPDATE') AS update,
        has_table_privilege(current_user,'notebook_versions','DELETE') AS delete
    `)
    ).rows[0];
    assert.deepEqual(privileges, {
      read: true,
      append: true,
      update: false,
      delete: false,
    });
    await assert.rejects(
      f.admin.query(
        `
      INSERT INTO notebook_versions(notebook_id,project_id,actor,revision,content,sha256,origin)
      SELECT notebook_id,project_id,actor,revision,content,sha256,'baseline'
      FROM notebook_versions WHERE id=$1
    `,
        [baseline.id],
      ),
      sqlState("23505"),
    );
    assert.deepEqual((await page(f)).versions, versions);
  },
);

/** @id TEST-NH-003 @verifies REQ-NH-003 */
test(
  "TEST-NH-003 bounded keyset history, stable-cell diffs and explicit display refusals enforce visible actor/project/notebook scope",
  { timeout: 240000 },
  async (t) => {
    const f = await fixture(t);
    await page(f);
    let current = f.notebook;
    for (let revision = 1; revision <= 50; revision++) {
      const body = structuredClone(current.document);
      body.cells[0].source = `x = ${revision}`;
      current = await f.notebooks.save("local", f.project.id, current.id, {
        revision,
        document: body,
      });
    }
    const first = await page(f, "?limit=50");
    assert.equal(first.versions.length, 50);
    assert.deepEqual(
      first.versions.map((v) => v.revision),
      Array.from({ length: 50 }, (_, index) => 51 - index),
    );
    assert.equal(first.nextCursor, first.versions.at(-1)?.id);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 128 * 1024);
    for (const version of first.versions) {
      assert.equal("document" in version, false);
      assert.equal("content" in version, false);
    }
    await f.notebooks.save("local", f.project.id, current.id, {
      revision: 51,
      document: current.document,
    });
    const last = await page(f, `?limit=50&before=${first.nextCursor}`);
    assert.deepEqual(
      last.versions.map((v) => v.revision),
      [1],
    );
    assert.equal(last.nextCursor, null);
    assert.equal(
      new Set([...first.versions, ...last.versions].map((v) => v.id)).size,
      51,
    );
    assert.equal((await page(f, "?limit=1")).versions.length, 1);
    assert.ok((await page(f)).versions.length <= 50);
    for (const query of [
      "?limit=0",
      "?limit=51",
      "?limit=-1",
      "?limit=1.5",
      "?limit=no",
      "?limit=",
      "?before=",
      "?before=0",
      "?before=-1",
      "?before=1.5",
      "?before=1e3",
      "?before=not-an-id",
      "?before=9223372036854775808",
    ])
      assert.equal((await request(f, "/versions" + query)).status, 400, query);
    for (const selector of ["0", "-1", "1.5", "not-a-revision", "2147483648"])
      assert.equal(
        (await request(f, "/versions/" + selector)).status,
        400,
        selector,
      );
    assert.equal((await request(f, "/versions/99")).status, 404);
    for (const against of ["", "0", "-1", "NaN", "1.5", "2147483648"])
      assert.equal(
        (await request(f, "/versions/2/diff?against=" + against)).status,
        400,
      );
    assert.equal((await request(f, "/versions/2/diff")).status, 400);
    assert.equal((await request(f, "/versions/2/diff?against=99")).status, 404);

    const compared = await f.notebooks.create("local", f.project.id, {
      name: "Before name",
      document: document(),
    });
    const target = { ...f, notebook: compared };
    const after = structuredClone(compared.document);
    const code = after.cells[0];
    assert.equal(code.cell_type, "code");
    code.source = "x <- 29";
    code.metadata.aira = {
      language: "r",
      sharing: [{ name: "x", direction: "r-to-python", family: "scalar" }],
    };
    const raw = after.cells[2];
    assert.ok(raw.cell_type === "raw");
    after.cells = [
      after.cells[3],
      code,
      { id: "new-cell", cell_type: "markdown", source: "Added", metadata: {} },
      { ...raw, cell_type: "markdown", metadata: { custom: "changed" } },
    ];
    await f.notebooks.save("local", f.project.id, compared.id, {
      revision: 1,
      name: "After name",
      document: after,
    });
    const diffResponse = await request(target, "/versions/2/diff?against=1");
    assert.equal(diffResponse.status, 200);
    const diff = z
      .object({
        fromRevision: z.number(),
        toRevision: z.number(),
        nameChanged: z.boolean(),
        beforeName: z.string(),
        afterName: z.string(),
        cells: z.array(
          z.object({
            id: z.string(),
            before: z.unknown(),
            after: z.unknown(),
            beforeIndex: z.number().nullable(),
            afterIndex: z.number().nullable(),
            changes: z.array(
              z.enum([
                "added",
                "removed",
                "source",
                "type",
                "metadata",
                "order",
              ]),
            ),
          }),
        ),
      })
      .parse(await diffResponse.json());
    assert.deepEqual(
      [
        diff.fromRevision,
        diff.toRevision,
        diff.nameChanged,
        diff.beforeName,
        diff.afterName,
      ],
      [1, 2, true, "Before name", "After name"],
    );
    const cells = new Map(diff.cells.map((cell) => [cell.id, cell]));
    assert.equal(cells.size, 5);
    for (const [id, changes, beforeIndex, afterIndex] of [
      ["code-a", ["source", "metadata", "order"], 0, 1],
      ["code-b", ["removed"], 1, null],
      ["markdown-a", ["order"], 3, 0],
      ["new-cell", ["added"], null, 2],
      ["raw-a", ["type", "metadata", "order"], 2, 3],
    ] as const) {
      const cell = cells.get(id);
      assert.ok(cell, id);
      assert.deepEqual([...cell.changes].sort(), [...changes].sort(), id);
      assert.equal(cell.beforeIndex, beforeIndex, id);
      assert.equal(cell.afterIndex, afterIndex, id);
      assert.deepEqual(
        cell.before,
        beforeIndex === null
          ? null
          : sourceOnly(compared.document).cells[beforeIndex],
      );
      assert.deepEqual(
        cell.after,
        afterIndex === null ? null : sourceOnly(after).cells[afterIndex],
      );
    }
    const same = await request(target, "/versions/1/diff?against=1");
    assert.equal(same.status, 200);
    assert.deepEqual(
      z
        .object({ cells: z.array(z.unknown()), nameChanged: z.boolean() })
        .parse(await same.json()),
      { cells: [], nameChanged: false },
    );
    assert.equal(
      (await detail(target, 1)).document.cells[3].source,
      compared.document.cells[3].source,
    );

    const privateNotebook = await f.notebooks.create("other", f.foreign.id, {
      name: "Foreign secret",
      document: document(),
    });
    for (const suffix of [
      "/versions",
      "/versions/1",
      "/versions/2/diff?against=1",
    ]) {
      assert.equal(
        (
          await request(
            f,
            suffix,
            "GET",
            undefined,
            f.foreign.id,
            privateNotebook.id,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            f,
            suffix,
            "GET",
            undefined,
            f.project.id,
            privateNotebook.id,
          )
        ).status,
        404,
      );
      assert.equal(
        (await request(f, suffix, "GET", undefined, f.foreign.id, compared.id))
          .status,
        404,
      );
      assert.equal(
        (await request(f, suffix, "GET", undefined, randomUUID(), compared.id))
          .status,
        404,
      );
    }
    await f.admin.query(
      "UPDATE projects SET hidden_at=clock_timestamp() WHERE id=$1",
      [f.project.id],
    );
    try {
      for (const suffix of [
        "/versions",
        "/versions/1",
        "/versions/2/diff?against=1",
      ])
        assert.equal((await request(target, suffix)).status, 404);
    } finally {
      await f.admin.query("UPDATE projects SET hidden_at=NULL WHERE id=$1", [
        f.project.id,
      ]);
    }
    await f.admin.query("UPDATE projects SET status='archived' WHERE id=$1", [
      f.project.id,
    ]);
    try {
      await page(target);
      await detail(target, 1);
      assert.equal(
        (await request(target, "/versions/2/diff?against=1")).status,
        200,
      );
      assert.equal(
        (await request(target, "/history")).status,
        200,
        "execution history remains distinct",
      );
    } finally {
      await f.admin.query("UPDATE projects SET status='active' WHERE id=$1", [
        f.project.id,
      ]);
    }
    const hostile = await notebookRoutes(f.notebooks)(
      new Request(
        `http://localhost/api/projects/${f.project.id}/notebooks/${compared.id}/versions`,
        { headers: { Host: "localhost", Origin: "https://foreign.invalid" } },
      ),
    );
    assert.equal(hostile.status, 403);

    // Exchange retains original metadata as well as native metadata: wire <12 MiB,
    // complete saved source >12 MiB. Display refusal must not prevent restoration.
    const largeWire = document();
    largeWire.metadata.large = "x".repeat(7 * 1024 * 1024);
    const imported = await new Exchange(f.notebooks).import(
      "local",
      f.project.id,
      "Large retained metadata",
      Buffer.from(JSON.stringify(largeWire)),
    );
    const large = { ...f, notebook: imported };
    assert.ok(
      Buffer.byteLength(JSON.stringify((await page(large)).versions)) < 4096,
    );
    const refused = await request(large, "/versions/1");
    assert.equal(refused.status, 413);
    assert.ok(
      z.object({ code: z.string().min(1) }).parse(await refused.json()).code,
    );
    await f.notebooks.save("local", f.project.id, imported.id, {
      revision: 1,
      document: imported.document,
    });
    assert.equal(
      (await request(large, "/versions/2/diff?against=1")).status,
      413,
    );
    assert.equal(
      (
        await request(large, "/versions/1/restore", "POST", {
          revision: 2,
          editorName: "Large restore",
        })
      ).status,
      200,
    );
    assert.equal((await page(large)).versions[0].revision, 3);
  },
);

/** @id TEST-NH-004 @verifies REQ-NH-004 */
test(
  "TEST-NH-004 restore appends revision/provenance without YAML restamping or research replay; stale, wrong-scope, archive and faults are inert",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t);
    await page(f);
    await runRecord(f);
    const historic = await detail(f, 1);
    let current = f.notebook;
    for (let revision = 1; revision <= 2; revision++) {
      const body = structuredClone(current.document);
      body.cells[0].source = `x = ${revision + 100}`;
      body.cells[3].source = `# New source ${revision}`;
      current = await f.notebooks.save("local", f.project.id, current.id, {
        revision,
        name: "Current changed name",
        document: body,
      });
    }
    const research = await researchRecords(f);
    const before = Date.now();
    const restoredResponse = await request(f, "/versions/1/restore", "POST", {
      revision: 3,
      editorName: "Self-declared Restorer",
    });
    assert.equal(restoredResponse.status, 200);
    const restoredBody = z
      .object({ id: z.uuid(), revision: z.number(), name: z.string() })
      .parse(await restoredResponse.json());
    assert.equal(restoredBody.revision, 4);
    const restored = await f.notebooks.get("local", f.project.id, current.id);
    assert.equal(restored.name, historic.name);
    assert.deepEqual(sourceOnly(restored.document), historic.document);
    assert.equal(
      restored.document.cells[3].source,
      historic.document.cells[3].source,
    );
    const event = (await page(f)).versions[0];
    assert.deepEqual(
      [event.revision, event.origin, event.restoredFrom, event.editor],
      [4, "restore", 1, "Self-declared Restorer"],
    );
    assert.ok(Date.parse(event.createdAt) >= before);
    await assertCanonical(f, event, restored);
    assert.deepEqual(await detail(f, 1), historic);
    assert.deepEqual(
      await researchRecords(f),
      research,
      "restore must neither run nor send research",
    );
    assert.equal(restored.results["code-a"].stale, true);
    assert.deepEqual(restored.results["code-a"].currentOutputs, []);
    assert.equal(
      (
        await request(f, "/versions/1/restore", "POST", {
          revision: 3,
          editorName: "Old confirmation",
        })
      ).status,
      409,
    );
    for (const body of [
      { revision: 4 },
      { revision: 4, editorName: "" },
      { revision: 4, editorName: 4 },
      { revision: 0, editorName: "Actor" },
      { revision: "4", editorName: "Actor" },
      { revision: 4.5, editorName: "Actor" },
      { revision: 4, editorName: "Actor", document: document() },
      { revision: 4, editorName: "Actor", name: "forged history" },
    ])
      assert.equal(
        (await request(f, "/versions/1/restore", "POST", body)).status,
        400,
      );
    assert.equal(
      (
        await request(f, "/versions/99/restore", "POST", {
          revision: 4,
          editorName: "Actor",
        })
      ).status,
      404,
    );
    const privateNotebook = await f.notebooks.create("other", f.foreign.id, {
      name: "Private",
      document: document(),
    });
    for (const [projectId, id] of [
      [f.project.id, privateNotebook.id],
      [f.foreign.id, privateNotebook.id],
      [f.foreign.id, current.id],
    ])
      assert.equal(
        (
          await request(
            f,
            "/versions/1/restore",
            "POST",
            {
              revision: 4,
              editorName: "Actor",
            },
            projectId,
            id,
          )
        ).status,
        404,
      );
    for (const state of ["archived", "hidden"] as const) {
      await f.admin.query(
        state === "archived"
          ? "UPDATE projects SET status='archived' WHERE id=$1"
          : "UPDATE projects SET hidden_at=clock_timestamp() WHERE id=$1",
        [f.project.id],
      );
      try {
        assert.equal(
          (
            await request(f, "/versions/1/restore", "POST", {
              revision: 4,
              editorName: "Actor",
            })
          ).status,
          state === "archived" ? 409 : 404,
        );
      } finally {
        await f.admin.query(
          "UPDATE projects SET status='active',hidden_at=NULL WHERE id=$1",
          [f.project.id],
        );
      }
    }
    assert.equal(
      (await f.notebooks.get("local", f.project.id, current.id)).revision,
      4,
    );
    const counts = await eventCounts(f);
    await f.admin.query(`
      CREATE FUNCTION nh_reject_restore() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.origin='restore' THEN RAISE EXCEPTION 'injected restore append failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER nh_reject_restore BEFORE INSERT ON notebook_versions
      FOR EACH ROW EXECUTE FUNCTION nh_reject_restore()
    `);
    try {
      assert.equal(
        (
          await request(f, "/versions/1/restore", "POST", {
            revision: 4,
            editorName: "Actor",
          })
        ).status,
        500,
      );
      assert.equal(
        (await f.notebooks.get("local", f.project.id, current.id)).revision,
        4,
      );
      assert.deepEqual(await eventCounts(f), counts);
    } finally {
      await f.admin.query(
        "DROP TRIGGER nh_reject_restore ON notebook_versions; DROP FUNCTION nh_reject_restore()",
      );
    }
    const savedContent = (
      await f.admin.query<{ canonical: string }>(
        "SELECT content::text AS canonical FROM notebook_versions WHERE id=$1",
        [historic.version.id],
      )
    ).rows[0].canonical;
    await f.admin.query(
      "UPDATE notebook_versions SET content=jsonb_set(content,'{name}','\"tampered\"') WHERE id=$1",
      [historic.version.id],
    );
    try {
      assert.equal(
        (
          await request(f, "/versions/1/restore", "POST", {
            revision: 4,
            editorName: "Actor",
          })
        ).status,
        503,
        "canonical hash must be checked before restoration",
      );
      assert.deepEqual(await eventCounts(f), counts);
    } finally {
      await f.admin.query(
        "UPDATE notebook_versions SET content=$2::jsonb WHERE id=$1",
        [historic.version.id, savedContent],
      );
    }
    const concurrent = await Promise.all([
      request(f, "/versions/1/restore", "POST", {
        revision: 4,
        editorName: "First",
      }),
      request(f, "/versions/1/restore", "POST", {
        revision: 4,
        editorName: "Second",
      }),
    ]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await page(f)).versions.length, 5);
    assert.deepEqual(await researchRecords(f), research);
  },
);

function assertWorker(
  value: unknown,
): asserts value is { start(): Promise<void> } {
  assert.ok(value && typeof value === "object" && "start" in value);
  assert.equal(typeof value.start, "function");
}
async function startWorker(f: Fixture) {
  assert.ok(
    "versions" in f.notebooks,
    "Notebooks exposes the initialized versions service",
  );
  const worker = f.notebooks.versions;
  assertWorker(worker);
  await worker.start();
}
async function untilPage(
  f: Parameters<typeof request>[0],
  predicate: (value: z.infer<typeof pageSchema>) => boolean | Promise<boolean>,
  message: string,
  timeout = 45000,
) {
  const deadline = Date.now() + timeout;
  let value = await page(f);
  while (!(await predicate(value)) && Date.now() < deadline) {
    await delay(100);
    value = await page(f);
  }
  assert.ok(await predicate(value), `${message}: ${JSON.stringify(value)}`);
  return value;
}
async function repositories(f: Fixture) {
  const found: string[] = [];
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (
      entries.some((e) => e.name === "HEAD" && e.isFile()) &&
      entries.some((e) => e.name === "objects" && e.isDirectory())
    ) {
      found.push(directory);
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory()) await visit(join(directory, entry.name));
  }
  for (const entry of await readdir(f.state, { withFileTypes: true }))
    if (entry.isDirectory() && !f.infrastructure.has(entry.name))
      await visit(join(f.state, entry.name));
  return found;
}
async function git(repository: string, ...args: string[]) {
  return (
    await execute("/usr/bin/git", ["--git-dir", repository, ...args], {
      env: {
        NODE_ENV: "test",
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout.trim();
}
async function restoreArtifact(
  f: Fixture,
  archive: string,
  destination: string,
) {
  f.cleanup.push(async () => {
    const exists = await stat(destination).then(
      () => true,
      (error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return false;
        throw error;
      },
    );
    if (exists) {
      const credentials = await loadCredentials(destination);
      await removeOwned(await readDatabaseIdentity(destination, credentials));
      await rm(destination, { recursive: true });
    }
  });
  return restoreValidation(archive, destination);
}

/** @id TEST-NH-006 @verifies REQ-NH-006 */
test(
  "TEST-NH-006 bounded automatic export, project-ordered retry/ref-before-ack recovery, generation rebuild and independent validated backup restore",
  { timeout: 360000 },
  async (t) => {
    const f = await fixture(t);
    const initial = await page(f);
    assert.equal(initial.versions[0].git.state, "pending");
    assert.equal(initial.versions[0].git.attempts, 0);
    const journal = await f.notebooks.labNote("local", f.project.id);
    const projectHead = { ...f, notebook: journal };
    const journalInitial = await page(projectHead);
    assert.deepEqual(
      journalInitial.versions.map((v) => [v.revision, v.origin]),
      [[1, "create"]],
    );
    await f.notebooks.save("local", f.project.id, f.notebook.id, {
      revision: 1,
      document: f.notebook.document,
    });
    const sameProject = await f.notebooks.create("local", f.project.id, {
      name: "Second notebook",
      document: document(),
    });
    const allResearch = await researchRecords(f);
    const allEvents = await eventCounts(f);
    const noGit = join(f.state, "no-git-test");
    await mkdir(noGit, { mode: 0o700 });
    f.infrastructure.add("no-git-test");
    const previousPath = process.env.PATH;
    process.env.PATH = noGit;
    let blocked: z.infer<typeof pageSchema>;
    try {
      await startWorker(f);
      const blockedJournal = await untilPage(
        projectHead,
        (value) => {
          const head = value.versions.find((v) => v.revision === 1);
          return head?.git.state === "blocked" && head.git.attempts === 3;
        },
        "missing Git must exhaust exactly three bounded attempts",
      );
      blocked = await page(f);
      assert.ok(blocked.git.errorCode);
      assert.equal(blocked.git.status, "blocked");
      const earliest = blockedJournal.versions.find((v) => v.revision === 1);
      assert.ok(earliest?.git.errorCode);
      assert.equal(earliest.git.commit, null);
      assert.equal(blocked.versions[0].git.state, "pending");
      assert.equal(blocked.versions[0].git.attempts, 0);
      assert.ok(
        blocked.versions.every(
          (v) => v.git.state === "pending" && v.git.attempts === 0,
        ),
      );
      const second = (await page({ ...f, notebook: sameProject })).versions[0];
      assert.equal(
        second.git.state,
        "pending",
        "another notebook cannot bypass the project head",
      );
      assert.equal(second.git.attempts, 0);
      await delay(300);
      assert.equal(
        (await page(projectHead)).versions.find((v) => v.revision === 1)?.git
          .attempts,
        3,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    assert.deepEqual(
      await eventCounts(f),
      allEvents,
      "Git failure cannot undo or fabricate DB research saves",
    );
    assert.deepEqual(await researchRecords(f), allResearch);
    const otherProject = await f.sessions.createProject(
      "local",
      "Independent export project",
    );
    const otherNotebook = await f.notebooks.create("local", otherProject.id, {
      name: "Other project continues",
      document: document(),
    });
    await untilPage(
      { ...f, project: otherProject, notebook: otherNotebook },
      (value) => value.versions.every((v) => v.git.state === "exported"),
      "a blocked project must not block other projects",
    );
    assert.equal((await page(f)).git.status, "blocked");

    const table = await exportsTable(f.admin);
    const earliestId = initial.versions[0].id;
    await f.admin.query(`
      CREATE FUNCTION nh_ref_before_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.version_id=${BigInt(journalInitial.versions[0].id)} AND NEW.state='exported' THEN
          RAISE EXCEPTION 'injected ref-before-ack interruption';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER nh_ref_before_ack BEFORE UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION nh_ref_before_ack()
    `);
    let repository: string;
    try {
      const retries = await Promise.all([
        request(f, "/versions/git/retry", "POST", {}),
        request(
          { ...f, notebook: sameProject },
          "/versions/git/retry",
          "POST",
          {},
        ),
      ]);
      for (const response of retries) {
        assert.equal(response.status, 202);
        z.object({ git: gitStatus }).parse(await response.json());
      }
      await untilPage(
        projectHead,
        async (value) => {
          const head = value.versions.find((v) => v.revision === 1);
          if (head?.git.state !== "blocked" || head.git.attempts !== 3)
            return false;
          const candidates = (await repositories(f)).filter((path) =>
            path.includes(f.project.id),
          );
          return (
            candidates.length === 1 &&
            (await git(candidates[0], "rev-list", "--all", "--count")) === "1"
          );
        },
        "a post-ref DB acknowledgement failure remains explicitly unsynchronized",
      );
      const candidates = (await repositories(f)).filter((path) =>
        path.includes(f.project.id),
      );
      assert.equal(candidates.length, 1);
      repository = candidates[0];
      assert.equal(
        await git(repository, "rev-list", "--all", "--count"),
        "1",
        "retrying an unacknowledged ref update must not append duplicate commits",
      );
      assert.equal(
        (await page(f)).versions[0].git.attempts,
        0,
        "later versions cannot pass an unacknowledged ref",
      );
    } finally {
      await f.notebooks.close();
      await f.admin.query(
        `DROP TRIGGER nh_ref_before_ack ON ${table}; DROP FUNCTION nh_ref_before_ack()`,
      );
    }
    const afterRestart = new Notebooks(
      f.operations,
      f.provenance,
      f.runtime,
      f.state,
      f.credentials,
    );
    f.notebooks = afterRestart;
    f.cleanup.push(() => afterRestart.close());
    await startWorker(f);
    assert.equal(
      (await request(f, "/versions/git/retry", "POST", {})).status,
      202,
    );
    let exported = await untilPage(
      f,
      (value) => value.versions.every((v) => v.git.state === "exported"),
      "exact head reconciliation must acknowledge once and continue in order",
    );
    await untilPage(
      { ...f, notebook: sameProject },
      (value) => value.versions[0].git.state === "exported",
      "project successor export",
    );
    exported = await page(f);
    assert.equal(await git(repository, "rev-list", "--all", "--count"), "4");
    assert.equal(exported.git.status, "exported");
    assert.ok(
      exported.versions.every((v) => v.git.commit && v.git.errorCode === null),
    );
    const paths = (
      await git(repository, "ls-tree", "-r", "--name-only", "HEAD")
    ).split("\n");
    for (const notebook of [journal, f.notebook, sameProject]) {
      const path = paths.find(
        (path) => path.includes(notebook.id) && path.endsWith(".ipynb"),
      );
      assert.ok(
        path,
        "export must preserve both notebooks' UUID-keyed source snapshots",
      );
      assert.deepEqual(
        JSON.parse(await git(repository, "show", `HEAD:${path}`)),
        sourceOnly(notebook.document),
      );
    }
    const beforeRebuild = await eventCounts(f);
    const oldHead = await git(repository, "rev-parse", "HEAD");
    const generation = exported.git.generation;
    assert.ok(generation);
    for (const body of [
      {},
      { generation },
      { generation, confirmed: false },
      { generation: "../unsafe", confirmed: true },
    ])
      assert.equal(
        (await request(f, "/versions/git/rebuild", "POST", body)).status,
        400,
      );
    assert.equal(
      (
        await request(f, "/versions/git/rebuild", "POST", {
          generation: randomUUID(),
          confirmed: true,
        })
      ).status,
      409,
      "rebuild confirmation binds the displayed generation",
    );
    const rebuildResponses = await Promise.all([
      request(f, "/versions/git/rebuild", "POST", {
        generation,
        confirmed: true,
      }),
      request(
        { ...f, notebook: sameProject },
        "/versions/git/rebuild",
        "POST",
        {
          generation,
          confirmed: true,
        },
      ),
    ]);
    const rebuiltGenerations: (string | null)[] = [];
    for (const response of rebuildResponses) {
      assert.equal(
        response.status,
        202,
        "concurrent project-wide rebuilds coalesce",
      );
      const body = z.object({ git: gitStatus }).parse(await response.json());
      assert.equal(body.git.rebuilt, true);
      rebuiltGenerations.push(body.git.generation);
    }
    assert.equal(new Set(rebuiltGenerations).size, 1);
    assert.notEqual(rebuiltGenerations[0], generation);
    const rebuilt = await untilPage(
      f,
      (value) => value.versions.every((v) => v.git.state === "exported"),
      "new generation replays retained committed snapshots, not research execution",
    );
    await untilPage(
      { ...f, notebook: sameProject },
      (value) => value.versions[0].git.state === "exported",
      "rebuilt shared-project successor",
    );
    assert.ok(rebuilt.versions.every((v) => v.git.attempts <= 3));
    assert.deepEqual(
      rebuilt.versions.map((v) => [v.id, v.sha256]),
      exported.versions.map((v) => [v.id, v.sha256]),
    );
    assert.equal(
      await git(repository, "rev-parse", "HEAD"),
      oldHead,
      "old repository is preserved unchanged",
    );
    const newRepositories = (await repositories(f)).filter(
      (path) => path.includes(f.project.id) && path !== repository,
    );
    assert.equal(newRepositories.length, 1);
    assert.equal(
      await git(newRepositories[0], "rev-list", "--all", "--count"),
      "4",
    );
    assert.deepEqual(await eventCounts(f), beforeRebuild);
    assert.deepEqual(await researchRecords(f), allResearch);

    await f.admin.query("UPDATE projects SET status='archived' WHERE id=$1", [
      f.project.id,
    ]);
    try {
      assert.equal(
        (await request(f, "/versions/git/retry", "POST", {})).status,
        202,
      );
    } finally {
      await f.admin.query("UPDATE projects SET status='active' WHERE id=$1", [
        f.project.id,
      ]);
    }
    const privateNotebook = await f.notebooks.create("other", f.foreign.id, {
      name: "Private",
      document: document(),
    });
    for (const action of ["retry", "rebuild"]) {
      const body =
        action === "retry"
          ? {}
          : { generation: rebuilt.git.generation, confirmed: true };
      assert.equal(
        (
          await request(
            f,
            `/versions/git/${action}`,
            "POST",
            body,
            f.foreign.id,
            privateNotebook.id,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await request(
            f,
            `/versions/git/${action}`,
            "POST",
            body,
            f.project.id,
            privateNotebook.id,
          )
        ).status,
        404,
      );
      await f.admin.query(
        "UPDATE projects SET hidden_at=clock_timestamp() WHERE id=$1",
        [f.project.id],
      );
      try {
        assert.equal(
          (await request(f, `/versions/git/${action}`, "POST", body)).status,
          404,
        );
      } finally {
        await f.admin.query("UPDATE projects SET hidden_at=NULL WHERE id=$1", [
          f.project.id,
        ]);
      }
    }
    await f.notebooks.close();
    const frozenHeads = await Promise.all(
      (await repositories(f))
        .filter(
          (path) =>
            path.includes(f.project.id) || path.includes(otherProject.id),
        )
        .map(
          async (path) => [path, await git(path, "rev-parse", "HEAD")] as const,
        ),
    );
    await delay(300);
    for (const [path, head] of frozenHeads)
      assert.equal(
        await git(path, "rev-parse", "HEAD"),
        head,
        "close awaits and stops owned export admission",
      );
    await f.operations.close();

    const artifacts = await mkdtemp(
      join(resolve(".scratch"), "history-backup-"),
    );
    f.cleanup.push(() => rm(artifacts, { recursive: true }));
    const archive = join(artifacts, "authoritative");
    await backup(f.state, archive);
    assert.deepEqual((await readdir(archive)).sort(), [
      "blobs",
      "manifest.json",
      "research.dump",
    ]);
    const restoredState = await restoreArtifact(
      f,
      archive,
      join(artifacts, "independent"),
    );
    assert.notEqual(
      restoredState.credentials.applicationId,
      f.credentials.applicationId,
    );
    const restoredOperations = new Operations(
      restoredState.state,
      restoredState.credentials,
    );
    f.cleanup.push(() => restoredOperations.close());
    await restoredOperations.acquire();
    const restoredStorage = new FileStorage(
      await storageDirectory(restoredState.state),
    );
    await restoredStorage.initialize();
    const restoredFiles = new Files(
      restoredOperations,
      restoredStorage,
      restoredState.state,
      restoredState.credentials,
    );
    f.cleanup.push(() => restoredFiles.close());
    const restoredProvenance = new Provenance(
      restoredOperations,
      restoredFiles,
      restoredState.state,
      restoredState.credentials,
    );
    f.cleanup.push(() => restoredProvenance.close());
    const restoredNotebooks = new Notebooks(
      restoredOperations,
      restoredProvenance,
      f.runtime,
      restoredState.state,
      restoredState.credentials,
    );
    f.cleanup.push(() => restoredNotebooks.close());
    const restoredTarget = { ...f, notebooks: restoredNotebooks };
    const restoredVersions = await page(restoredTarget);
    assert.deepEqual(
      restoredVersions.versions.map((v) => [v.id, v.sha256]),
      rebuilt.versions.map((v) => [v.id, v.sha256]),
    );
    assert.ok(
      restoredVersions.versions.every(
        (v) =>
          v.git.state === "pending" &&
          v.git.commit === null &&
          v.git.attempts === 0,
      ),
    );
    assert.equal(
      restoredVersions.git.generation,
      null,
      "independent restore must discard source generation authority",
    );
    assert.deepEqual(
      (await detail(restoredTarget, 1)).document,
      sourceOnly(f.notebook.document),
    );

    const validContent = (
      await f.admin.query<{ content: string; sha256: string }>(
        "SELECT content::text AS content,sha256 FROM notebook_versions WHERE id=$1",
        [earliestId],
      )
    ).rows[0];
    for (const corruption of ["hash", "head", "missing"] as const) {
      const badArchive = join(artifacts, "corrupt-" + corruption);
      if (corruption === "hash")
        await f.admin.query(
          "UPDATE notebook_versions SET sha256=$2 WHERE id=$1",
          [earliestId, "0".repeat(64)],
        );
      else if (corruption === "head")
        await f.admin.query(
          "UPDATE notebooks SET name='mismatching authoritative head' WHERE id=$1",
          [f.notebook.id],
        );
      else
        await f.admin.query(
          "UPDATE notebooks SET revision=revision+1 WHERE id=$1",
          [f.notebook.id],
        );
      try {
        await backup(f.state, badArchive);
        await assert.rejects(
          restoreArtifact(
            f,
            badArchive,
            join(artifacts, "reject-" + corruption),
          ),
          (error: unknown) =>
            error instanceof ServiceError && error.status === 503,
          `restore validation must refuse ${corruption} corruption`,
        );
      } finally {
        await f.admin.query(
          "UPDATE notebook_versions SET content=$2::jsonb,sha256=$3 WHERE id=$1",
          [earliestId, validContent.content, validContent.sha256],
        );
        await f.admin.query(
          "UPDATE notebooks SET name=$2,revision=2 WHERE id=$1",
          [f.notebook.id, f.notebook.name],
        );
      }
    }
    const lifecycleBase = await fixture(t);
    const lifecycle = {
      ...lifecycleBase,
      notebook: await lifecycleBase.notebooks.labNote(
        "local",
        lifecycleBase.project.id,
      ),
    };
    await page(lifecycle);
    const unavailable = join(lifecycle.state, "unavailable-git-test");
    await mkdir(unavailable, { mode: 0o700 });
    lifecycle.infrastructure.add("unavailable-git-test");
    const pathBeforeShutdown = process.env.PATH;
    process.env.PATH = unavailable;
    try {
      await startWorker(lifecycle);
      await untilPage(
        lifecycle,
        (value) => value.versions[0].git.attempts >= 1,
        "automatic worker must admit an owned pending attempt",
      );
      await lifecycle.notebooks.close();
    } finally {
      if (pathBeforeShutdown === undefined) delete process.env.PATH;
      else process.env.PATH = pathBeforeShutdown;
    }
    const stoppedReader = new Notebooks(
      lifecycle.operations,
      lifecycle.provenance,
      lifecycle.runtime,
      lifecycle.state,
      lifecycle.credentials,
    );
    lifecycle.notebooks = stoppedReader;
    lifecycle.cleanup.push(() => stoppedReader.close());
    const stopped = await page(lifecycle);
    await delay(400);
    assert.deepEqual(
      (await page(lifecycle)).versions,
      stopped.versions,
      "shutdown stops pending retry admission as well as owned child work",
    );
    await lifecycle.admin.query("UPDATE writer_control SET epoch=epoch+1");
    await startWorker(lifecycle).then(
      () => undefined,
      (error: unknown) => assert.ok(status(503)(error)),
    );
    await delay(400);
    assert.deepEqual(
      (await page(lifecycle)).versions,
      stopped.versions,
      "observed lease loss must not admit or acknowledge further exports",
    );
    assert.equal((await repositories(lifecycle)).length, 0);
  },
);

/** @id TEST-NH-006-RESTART @verifies REQ-NH-006 */
test(
  "TEST-NH-006-RESTART interrupted third admission is explicitly blocked, not pending forever",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    await page(f);
    const table = await exportsTable(f.admin);
    await f.admin.query(`UPDATE ${table} SET state='pending',attempts=3`);
    const waiting = deferred<void>();
    const controlled = new Notebooks(
      f.operations,
      f.provenance,
      f.runtime,
      f.state,
      f.credentials,
      {
        exporter: {
          async exportVersion() {
            assert.fail("an exhausted admission requires explicit retry");
          },
        },
        clock: {
          now: Date.now,
          sleep(_milliseconds, signal) {
            waiting.resolve();
            return new Promise<void>((_done, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            });
          },
        },
      },
    );
    f.cleanup.push(() => controlled.close());
    await startWorker({ ...f, notebooks: controlled });
    await waiting.promise;
    const head = (await page(f)).versions[0];
    assert.equal(head.git.state, "blocked");
    assert.equal(head.git.attempts, 3);
    assert.ok(head.git.errorCode);
  },
);

/** @id TEST-NH-006-CLOCK @verifies REQ-NH-006 */
test(
  "TEST-NH-006-CLOCK automatic retries use a bounded abortable clock without real-time sleeps",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const journal = await f.notebooks.labNote("local", f.project.id);
    const projectHead = { ...f, notebook: journal };
    assert.deepEqual(
      (await page(projectHead)).versions.map((v) => [v.revision, v.origin]),
      [[1, "create"]],
    );
    let time = Date.now();
    const waits: { milliseconds: number; proceed(): void }[] = [];
    let waiting = deferred<void>();
    let attempts = 0;
    const otherProjects = new NotebookGit(f.state, f.credentials.applicationId);
    const clock = {
      now: () => time,
      sleep(milliseconds: number, signal: AbortSignal) {
        return new Promise<void>((done, reject) => {
          const aborted = () =>
            reject(new DOMException("Aborted", "AbortError"));
          signal.addEventListener("abort", aborted, { once: true });
          waits.push({
            milliseconds,
            proceed() {
              signal.removeEventListener("abort", aborted);
              time += milliseconds;
              done();
            },
          });
          waiting.resolve();
        });
      },
    };
    const exporter: Pick<NotebookGit, "exportVersion"> = {
      async exportVersion(context, event, options) {
        if (context.projectId !== f.project.id)
          return otherProjects.exportVersion(context, event, options);
        assert.equal(event.notebookId, journal.id);
        attempts++;
        throw new ServiceError(503, "CONTROLLED_GIT_UNAVAILABLE");
      },
    };
    const controlled = new Notebooks(
      f.operations,
      f.provenance,
      f.runtime,
      f.state,
      f.credentials,
      { clock, exporter },
    );
    f.cleanup.push(() => controlled.close());
    await startWorker({ ...f, notebooks: controlled });
    for (let expected = 1; expected <= 3; expected++) {
      await waiting.promise;
      assert.equal(attempts, expected);
      const state = (await page(projectHead)).versions[0];
      assert.equal(state.git.attempts, expected);
      assert.equal(state.git.state, expected === 3 ? "blocked" : "error");
      assert.equal(state.git.commit, null);
      if (expected < 3) {
        const wait = waits.shift();
        assert.ok(wait && wait.milliseconds > 0 && wait.milliseconds <= 30000);
        waiting = deferred<void>();
        wait.proceed();
      }
    }
    await controlled.close();
    assert.equal(
      attempts,
      3,
      "stop aborts the idle clock and no fourth attempt is admitted",
    );
  },
);

/** @id TEST-NH-006-STOP @verifies REQ-NH-006 */
test(
  "TEST-NH-006-STOP shutdown waits for the owned exporter to close and cannot acknowledge after abort or lease loss",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    await page(f);
    const entered = deferred<void>();
    const aborted = deferred<void>();
    const closed = deferred<void>();
    const exporter: Pick<NotebookGit, "exportVersion"> = {
      async exportVersion(_context, _event, options) {
        assert.ok(options.signal);
        options.signal.addEventListener("abort", () => aborted.resolve(), {
          once: true,
        });
        entered.resolve();
        await closed.promise;
        return { parent: null, tree: "a".repeat(40), commit: "b".repeat(40) };
      },
    };
    const controlled = new Notebooks(
      f.operations,
      f.provenance,
      f.runtime,
      f.state,
      f.credentials,
      { exporter },
    );
    f.cleanup.push(() => controlled.close());
    await startWorker({ ...f, notebooks: controlled });
    await entered.promise;
    await f.admin.query("UPDATE writer_control SET epoch=epoch+1");
    let finished = false;
    const stopping = controlled.close().then(() => {
      finished = true;
    });
    try {
      await aborted.promise;
      await nextTurn();
      assert.equal(
        finished,
        false,
        "closing must await the exact owned exporter, not just send abort",
      );
    } finally {
      closed.resolve();
      await stopping;
    }
    const version = (await page(f)).versions[0];
    assert.notEqual(version.git.state, "exported");
    assert.equal(
      version.git.commit,
      null,
      "an exporter return after lease loss is not DB acknowledgement",
    );
    assert.equal(
      (await f.notebooks.get("local", f.project.id, f.notebook.id)).revision,
      1,
    );
  },
);

/** @id TEST-NH-006-STOP-ONLY @verifies REQ-NH-006 */
test(
  "TEST-NH-006-STOP-ONLY shutdown alone prevents acknowledging a late successful exporter",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    await page(f);
    const entered = deferred<void>(),
      aborted = deferred<void>(),
      closed = deferred<void>();
    const controlled = new Notebooks(
      f.operations,
      f.provenance,
      f.runtime,
      f.state,
      f.credentials,
      {
        exporter: {
          async exportVersion(_context, _event, options) {
            assert.ok(options.signal);
            options.signal.addEventListener("abort", () => aborted.resolve(), {
              once: true,
            });
            entered.resolve();
            await closed.promise;
            return {
              parent: null,
              tree: "a".repeat(40),
              commit: "b".repeat(40),
            };
          },
        },
      },
    );
    f.cleanup.push(() => controlled.close());
    await startWorker({ ...f, notebooks: controlled });
    await entered.promise;
    let finished = false;
    const stopping = controlled.close().then(() => {
      finished = true;
    });
    try {
      await aborted.promise;
      await nextTurn();
      assert.equal(finished, false);
    } finally {
      closed.resolve();
      await stopping;
    }
    assert.notEqual((await page(f)).versions[0].git.state, "exported");
  },
);
