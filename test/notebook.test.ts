import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { migrate } from "../scripts/migrate";
import { backup, databaseTool, fileDigest } from "../scripts/backup";
import { restoreValidation } from "../scripts/restore-validation";
import { loadCredentials } from "../src/server/credentials";
import { readDatabaseIdentity } from "../src/server/db-container";
import { testDatabase } from "./helpers/database";
import { connectDatabase } from "../src/server/database";
import { testContainer } from "./helpers/containers";
import {
  inspectOwned,
  stopOwned,
  removeOwned,
  type ContainerIdentity,
} from "../src/server/owned-containers";
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
import { ServiceError } from "../src/server/http";
const status = (n: number) => (e: unknown) =>
  e instanceof ServiceError && e.status === n;
function document(): NotebookDocument {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: "python-1",
        cell_type: "code",
        source: "print('first')",
        metadata: {
          aira: {
            language: "python",
            sharing: [{ name: "x", direction: "python-to-r" }],
          },
        },
        outputs: [],
        execution_count: null,
      },
      {
        id: "r-1",
        cell_type: "code",
        source: "print(1L)",
        metadata: {
          aira: {
            language: "r",
            sharing: [
              { name: "x", direction: "r-to-python", family: "scalar" },
            ],
          },
        },
        outputs: [],
        execution_count: null,
      },
      {
        id: "raw-1",
        cell_type: "raw",
        source: "Raw attached text is never executed.",
        metadata: {},
        attachments: { "data.txt": { "text/plain": "aGVsbG8=" } },
      },
      {
        id: "markdown-1",
        cell_type: "markdown",
        source: "# Literal\n![remote](https://foreign.invalid/a)",
        metadata: {},
      },
    ],
  };
}
async function fixture(t: TestContext, legacy = false) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const action of cleanup.reverse()) await action();
  });
  const db = await testDatabase();
  cleanup.push(() => db.cleanup());
  if (legacy) {
    assert.ok(resolve(db.state).startsWith(resolve(".scratch") + "/db-"));
    const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
    try {
      await admin.query(
        "DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION aira_migration; GRANT USAGE ON SCHEMA public TO aira_application",
      );
    } finally {
      await admin.end();
    }
    const migration = await connectDatabase(
      db.state,
      db.credentials,
      "migration",
    );
    try {
      await migration.query("BEGIN");
      await migration.query(
        "CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
      );
      for (const name of (await readdir("src/server/migrations"))
        .filter((name) => /^\d{3}-.*\.sql$/.test(name) && name < "014-")
        .sort()) {
        await migration.query(
          await readFile(join("src/server/migrations", name), "utf8"),
        );
        await migration.query(
          "INSERT INTO schema_migrations(name) VALUES($1)",
          [name.slice(0, -4)],
        );
        if (name === "001-operations.sql")
          await migration.query(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON writer_control,jobs,grants,operation_containers TO aira_application",
          );
      }
      await migration.query("COMMIT");
    } finally {
      await migration.end();
    }
  }
  const operations = new Operations(db.state, db.credentials);
  cleanup.push(() => operations.close());
  await operations.acquire();
  const sessions = new Sessions(operations, db.state, db.credentials);
  cleanup.push(() => sessions.close());
  const project = await sessions.createProject("local", "notebook fixture");
  const foreign = await sessions.createProject(
    "other",
    "foreign notebook fixture",
  );
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
  const kernels = new Map<string, ContainerIdentity>(),
    invalidations: { id: string; epoch: string }[] = [];
  const runtime: NotebookRuntime = {
    async epoch(actor, projectId, id) {
      assert.equal(actor, "local");
      assert.equal(projectId, project.id);
      const kernel = kernels.get(id);
      return kernel && (await inspectOwned(kernel)).State.Running
        ? kernel.resourceId
        : null;
    },
    async invalidate(actor, projectId, id, epoch) {
      assert.equal(actor, "local");
      assert.equal(projectId, project.id);
      const kernel = kernels.get(id);
      assert.ok(
        kernel && kernel.resourceId === epoch,
        "must stop only the affected exact kernel epoch",
      );
      await stopOwned(kernel);
      invalidations.push({ id, epoch });
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
  async function run(notebook: Notebook, kernelEpoch: string) {
    const source = await notebooks.source(
      "local",
      project.id,
      notebook.id,
      "python-1",
    );
    const fingerprint = createHash("sha256").update(randomUUID()).digest("hex");
    const grantId = await operations.grant("local", "execution", fingerprint);
    const job = await operations.admit(
      {
        actor: "local",
        requestId: randomUUID(),
        purpose: "execution",
        fingerprint,
        grantId,
      },
      project.id,
    );
    const captured = await provenance.capture("local", project.id, {
      ...source,
      jobId: job.id,
      inputs: [],
      kernelEpoch,
      environment: {
        imageDigest: "sha256:" + "a".repeat(64),
        python: "synthetic-producer",
        r: "synthetic-producer",
        packages: {},
      },
    });
    await operations.dispatch("local", job.id);
    await operations.observeStarted("local", job.id);
    return captured;
  }
  return {
    ...db,
    operations,
    sessions,
    project,
    foreign,
    files,
    storage,
    provenance,
    notebooks,
    runtime,
    kernels,
    invalidations,
    cleanup,
    run,
  };
}

async function projectJournal(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await notebookRoutes(f.notebooks)(
    new Request(`http://127.0.0.1:3000/api/projects/${f.project.id}/lab-note`, {
      headers: { Host: "127.0.0.1:3000" },
    }),
  );
  assert.equal(
    response.status,
    200,
    "the project must expose its independent journal",
  );
  return (await response.json()) as Notebook;
}
/** @id TEST-NOTE-004 @verifies REQ-NOTE-004 */
test(
  "TEST-NOTE-004 one independent Markdown journal, multiple ipynb and atomic scoped history",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const journal = await projectJournal(f);
    assert.deepEqual(journal.document.cells, []);
    assert.equal((await projectJournal(f)).id, journal.id);
    const a = await f.notebooks.create("local", f.project.id, {
      name: "Lab Note",
      document: document(),
    });
    const b = await f.notebooks.create("local", f.project.id, {
      name: "Second ipynb",
      document: document(),
    });
    assert.deepEqual(
      (await f.notebooks.list("local", f.project.id)).map((n) => n.id).sort(),
      [a.id, b.id].sort(),
    );
    const body: NotebookDocument = {
      ...journal.document,
      cells: [
        {
          id: "journal-text",
          cell_type: "markdown",
          source: "# Journal\nRecord only.",
          metadata: {},
        },
      ],
    };
    const saved = await f.notebooks.save("local", f.project.id, journal.id, {
      revision: 1,
      document: body,
    });
    assert.equal(saved.revision, 2);
    const app = await connectDatabase(f.state, f.credentials, "application");
    f.cleanup.push(() => app.end());
    const before = (
      await app.query(
        "SELECT id,content,sha256 FROM notebook_versions WHERE notebook_id=$1 ORDER BY id",
        [journal.id],
      )
    ).rows;
    assert.equal(before.length, 2);
    for (const row of before) {
      const canonical = (
        await app.query(
          "SELECT content::text AS value FROM notebook_versions WHERE id=$1",
          [row.id],
        )
      ).rows[0].value;
      assert.equal(
        createHash("sha256").update(canonical).digest("hex"),
        row.sha256,
      );
    }
    for (const cell of [document().cells[0], document().cells[2]]) {
      await assert.rejects(
        f.notebooks.save("local", f.project.id, journal.id, {
          revision: 2,
          document: { ...body, cells: [cell] },
        }),
        status(400),
      );
      await assert.rejects(
        app.query("UPDATE notebooks SET document=$1::jsonb WHERE id=$2", [
          JSON.stringify({ ...body, cells: [cell] }),
          journal.id,
        ]),
        (e: unknown) => e instanceof Error && "code" in e && e.code === "23514",
      );
      await assert.rejects(
        app.query(
          `INSERT INTO notebook_versions(notebook_id,project_id,actor,revision,content,sha256,origin)
           VALUES($1,$2,'local',3,$3::jsonb,$4,'save')`,
          [
            journal.id,
            f.project.id,
            JSON.stringify({
              name: saved.name,
              document: { ...body, cells: [cell] },
            }),
            "a".repeat(64),
          ],
        ),
        (e: unknown) => e instanceof Error && "code" in e && e.code === "23514",
      );
    }
    await assert.rejects(
      app.query("DELETE FROM project_lab_notes WHERE project_id=$1", [
        f.project.id,
      ]),
      (e: unknown) => e instanceof Error && "code" in e && e.code === "42501",
    );
    await assert.rejects(
      app.query("SELECT provision_project_lab_note($1,$2,$3)", [
        f.project.id,
        "local",
        f.project.chatId,
      ]),
      (e: unknown) => e instanceof Error && "code" in e && e.code === "42501",
    );
    await assert.rejects(
      f.notebooks.save("local", f.project.id, journal.id, {
        revision: 1,
        document: body,
      }),
      status(409),
    );
    await assert.rejects(
      f.notebooks.get("other", f.project.id, journal.id),
      status(404),
    );
    await assert.rejects(
      f.notebooks.get("local", f.foreign.id, journal.id),
      status(404),
    );
    await assert.rejects(
      f.notebooks.labNote("other", f.project.id),
      status(404),
    );
    await assert.rejects(
      f.notebooks.labNote("local", f.foreign.id),
      status(404),
    );
    assert.deepEqual(
      (
        await app.query(
          "SELECT id,content,sha256 FROM notebook_versions WHERE notebook_id=$1 ORDER BY id",
          [journal.id],
        )
      ).rows,
      before,
    );
    const counts = (
      await app.query(
        "SELECT (SELECT count(*) FROM notebooks) AS books,(SELECT count(*) FROM notebook_versions) AS versions,(SELECT count(*) FROM notebook_git_exports) AS exports",
      )
    ).rows[0];
    await assert.rejects(
      f.operations.write(async (client) => {
        const p = randomUUID(),
          c = randomUUID();
        await client.query(
          "INSERT INTO projects(id,actor,chat_id,name) VALUES($1,'local',$2,'rollback')",
          [p, c],
        );
        await client.query(
          "INSERT INTO chats(id,project_id,actor) VALUES($1,$2,'local')",
          [c, p],
        );
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        assert.equal(
          (
            await client.query(
              "SELECT count(*)::int AS n FROM project_lab_notes WHERE project_id=$1",
              [p],
            )
          ).rows[0].n,
          1,
        );
        throw new Error("JOURNAL_ROLLBACK_CONTROL");
      }),
      /JOURNAL_ROLLBACK_CONTROL/,
    );
    assert.deepEqual(
      (
        await app.query(
          "SELECT (SELECT count(*) FROM notebooks) AS books,(SELECT count(*) FROM notebook_versions) AS versions,(SELECT count(*) FROM notebook_git_exports) AS exports",
        )
      ).rows[0],
      counts,
    );
    const admin = await connectDatabase(f.state, f.credentials, "bootstrap");
    f.cleanup.push(() => admin.end());
    await admin.query("DELETE FROM project_lab_notes WHERE project_id=$1", [
      f.project.id,
    ]);
    try {
      await assert.rejects(
        f.notebooks.labNote("local", f.project.id),
        (error: unknown) =>
          error instanceof ServiceError &&
          error.status === 503 &&
          error.code === "PROJECT_LAB_NOTE_MISSING",
      );
      assert.deepEqual(
        (
          await app.query(
            "SELECT (SELECT count(*) FROM notebooks) AS books,(SELECT count(*) FROM notebook_versions) AS versions,(SELECT count(*) FROM notebook_git_exports) AS exports",
          )
        ).rows[0],
        counts,
      );
    } finally {
      await admin.query("INSERT INTO project_lab_notes VALUES($1,$2,'local')", [
        f.project.id,
        journal.id,
      ]);
    }
    await admin.query(
      "UPDATE projects SET hidden_at=clock_timestamp() WHERE id=$1",
      [f.project.id],
    );
    try {
      await assert.rejects(
        f.notebooks.labNote("local", f.project.id),
        status(404),
      );
    } finally {
      await admin.query("UPDATE projects SET hidden_at=NULL WHERE id=$1", [
        f.project.id,
      ]);
    }
    await f.operations.write((client) =>
      client.query("UPDATE projects SET status='archived' WHERE id=$1", [
        f.project.id,
      ]),
    );
    assert.equal((await projectJournal(f)).id, journal.id);
    await assert.rejects(
      f.notebooks.save("local", f.project.id, journal.id, {
        revision: 2,
        document: body,
      }),
      status(409),
    );
  },
);
/** @id TEST-NOTE-005 @verifies REQ-NOTE-005 */
test(
  "TEST-NOTE-005 quiescent repeat-safe journal migration preserves existing notebooks and archived state",
  { timeout: 120000 },
  async (t) => {
    await projectJournal(await fixture(t));
    const f = await fixture(t, true);
    const existing = await f.notebooks.create("local", f.project.id, {
      name: "Demo Lab Note",
      document: document(),
    });
    await f.operations.write((client) =>
      client.query("UPDATE projects SET status='archived' WHERE id=$1", [
        f.project.id,
      ]),
    );
    const admin = await connectDatabase(f.state, f.credentials, "bootstrap");
    f.cleanup.push(() => admin.end());
    const before = (
      await admin.query(
        "SELECT to_jsonb(n) AS n,to_jsonb(l) AS l FROM notebooks n JOIN notebook_links l USING(id) WHERE n.id=$1",
        [existing.id],
      )
    ).rows;
    await assert.rejects(migrate(f.state, f.credentials), status(409));
    assert.equal(
      (
        await admin.query(
          "SELECT name FROM schema_migrations WHERE name='014-project-lab-note'",
        )
      ).rowCount,
      0,
    );
    await f.operations.close();
    await migrate(f.state, f.credentials);
    const journal = await projectJournal(f);
    assert.notEqual(journal.id, existing.id);
    assert.deepEqual(journal.document.cells, []);
    const versions = (
      await admin.query("SELECT * FROM notebook_versions ORDER BY id")
    ).rows;
    await migrate(f.state, f.credentials);
    assert.deepEqual(
      (await admin.query("SELECT * FROM notebook_versions ORDER BY id")).rows,
      versions,
    );
    assert.deepEqual(
      (
        await admin.query(
          "SELECT to_jsonb(n) AS n,to_jsonb(l) AS l FROM notebooks n JOIN notebook_links l USING(id) WHERE n.id=$1",
          [existing.id],
        )
      ).rows,
      before,
    );
    assert.equal(
      (
        await admin.query("SELECT status FROM projects WHERE id=$1", [
          f.project.id,
        ])
      ).rows[0].status,
      "archived",
    );
    assert.equal(
      (await admin.query("SELECT count(*)::int AS n FROM project_lab_notes"))
        .rows[0].n,
      2,
    );
  },
);
/** @id TEST-NOTE-006 @verifies REQ-NOTE-006 */
test(
  "TEST-NOTE-006 independent journal backup restore preserves identity and refuses missing associations",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const journal = await projectJournal(f);
    const body = {
      ...journal.document,
      cells: [
        {
          id: "record",
          cell_type: "markdown",
          source: "Exact journal ✓",
          metadata: {},
        },
      ],
    };
    await f.notebooks.save("local", f.project.id, journal.id, {
      revision: 1,
      document: body,
    });
    await f.operations.close();
    const root = await mkdtemp(resolve(".scratch/jnl-"));
    const cleanup: (() => Promise<unknown>)[] = [
      () => rm(root, { recursive: true, force: true }),
    ];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
    });
    const archive = join(root, "archive");
    await backup(f.state, archive);
    const restored = await restoreValidation(archive, join(root, "restored"));
    cleanup.push(() => removeOwned(restored.identity));
    const target = await connectDatabase(
      restored.state,
      restored.credentials,
      "bootstrap",
    );
    cleanup.push(() => target.end());
    assert.equal(
      (
        await target.query(
          "SELECT notebook_id FROM project_lab_notes WHERE project_id=$1",
          [f.project.id],
        )
      ).rows[0].notebook_id,
      journal.id,
    );
    assert.deepEqual(
      (
        await target.query("SELECT document FROM notebooks WHERE id=$1", [
          journal.id,
        ])
      ).rows[0].document,
      body,
    );
    assert.equal(
      (
        await target.query(
          "SELECT count(*)::int AS n FROM notebook_versions WHERE notebook_id=$1",
          [journal.id],
        )
      ).rows[0].n,
      2,
    );
    const operations = new Operations(restored.state, restored.credentials);
    cleanup.push(() => operations.close());
    await operations.acquire();
    const sessions = new Sessions(
      operations,
      restored.state,
      restored.credentials,
    );
    cleanup.push(() => sessions.close());
    const created = await sessions.createProject("local", "After restore");
    assert.equal(
      (
        await target.query(
          "SELECT count(*)::int AS n FROM project_lab_notes WHERE project_id=$1",
          [created.id],
        )
      ).rows[0].n,
      1,
    );
    const source = await connectDatabase(f.state, f.credentials, "bootstrap");
    f.cleanup.push(() => source.end());
    const integrityError = (error: unknown) =>
      error instanceof ServiceError &&
      error.status === 503 &&
      error.code === "PROJECT_LAB_NOTE_INTEGRITY_INVALID";
    const manifestPath = join(archive, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const kind of ["m", "h"]) {
      if (kind === "m") {
        await source.query(
          "DELETE FROM project_lab_notes WHERE project_id=$1",
          [f.project.id],
        );
      } else {
        await source.query(
          "INSERT INTO project_lab_notes VALUES($1,$2,'local')",
          [f.project.id, journal.id],
        );
        await source.query(
          "ALTER TABLE notebook_versions DISABLE TRIGGER project_lab_note_version",
        );
        try {
          await source.query(
            `INSERT INTO notebook_versions(notebook_id,project_id,actor,revision,content,sha256,origin)
             SELECT $1,$2,'local',3,body,encode(sha256(convert_to(body::text,'UTF8')),'hex'),'save'
             FROM (SELECT $3::jsonb AS body) saved`,
            [
              journal.id,
              f.project.id,
              JSON.stringify({
                name: journal.name,
                document: { ...body, cells: [document().cells[0]] },
              }),
            ],
          );
        } finally {
          await source.query(
            "ALTER TABLE notebook_versions ENABLE TRIGGER project_lab_note_version",
          );
        }
      }
      await assert.rejects(
        backup(f.state, join(root, `invalid-${kind}`)),
        integrityError,
      );
      await unlink(join(archive, "research.dump"));
      await databaseTool(
        f.identity,
        f.credentials,
        "pg_dump",
        [
          "-U",
          "aira_bootstrap",
          "-h",
          "/var/run/postgresql",
          "-d",
          "aira",
          "--format=custom",
          "--data-only",
          "--no-owner",
          "--no-acl",
          ...[...Object.keys(manifest.inert), "schema_migrations"].map(
            (table) => `--exclude-table-data=public.${table}`,
          ),
        ],
        join(archive, "research.dump"),
      );
      manifest.dumpSha256 = await fileDigest(join(archive, "research.dump"));
      await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      const failedState = join(root, `bad-${kind}`);
      cleanup.push(async () => {
        const exists = await stat(join(failedState, "database.json")).then(
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
        if (exists)
          await removeOwned(
            await readDatabaseIdentity(
              failedState,
              await loadCredentials(failedState),
            ),
          );
      });
      await assert.rejects(
        restoreValidation(archive, failedState),
        integrityError,
      );
    }
  },
);

/** @id TEST-NOTE-001 @verifies REQ-NOTE-001 */
test(
  "TEST-NOTE-001 bounded canonical nbformat mixed cells/sharing, owned immutable chat and raw attachments persist",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    let created: Notebook | undefined;
    const original = document();
    await assert.doesNotReject(async () => {
      created = await f.notebooks.create("local", f.project.id.toUpperCase(), {
        name: "研究ノート",
        document: original,
      });
    });
    assert.ok(created);
    assert.equal(created.chatId, f.project.chatId);
    assert.deepEqual(created.document.metadata.aira, {
      project_id: f.project.id,
      chat_id: f.project.chatId,
      notebook_id: created.id,
    });
    assert.equal(
      (await f.notebooks.source("local", f.project.id, created.id, "r-1"))
        .language,
      "r",
    );
    assert.deepEqual(
      (await f.notebooks.source("local", f.project.id, created.id, "r-1"))
        .sharing,
      [{ name: "x", direction: "r-to-python", family: "scalar" }],
    );
    assert.deepEqual(
      (await f.notebooks.source("local", f.project.id, created.id, "python-1"))
        .sharing,
      [{ name: "x", direction: "python-to-r" }],
    );
    assert.deepEqual(created.document.cells[2], original.cells[2]);
    original.cells[0].source = "caller mutation";
    assert.equal(
      (await f.notebooks.get("local", f.project.id, created.id)).document
        .cells[0].source,
      "print('first')",
    );
    await assert.rejects(
      f.notebooks.get("other", f.project.id, created.id),
      status(404),
    );
    const badAssociation = document();
    badAssociation.metadata.aira = { chat_id: f.foreign.chatId };
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "foreign",
        document: badAssociation,
      }),
      status(404),
    );
    const duplicate = document();
    duplicate.cells[1].id = duplicate.cells[0].id;
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "duplicate",
        document: duplicate,
      }),
      status(400),
    );
    const badLanguage = document();
    badLanguage.cells[0].metadata.aira = { language: "julia", sharing: [] };
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "unsupported",
        document: badLanguage,
      }),
      status(400),
    );
    const maximum = document();
    const code = maximum.cells[0];
    assert.ok(code.cell_type === "code");
    maximum.cells = Array.from({ length: 100 }, (_, i) => ({
      ...structuredClone(code),
      id: `cell-${i}`,
      source: "x".repeat(64 * 1024),
    }));
    const capacity = await f.notebooks.create("local", f.project.id, {
      name: "maximum",
      document: maximum,
    });
    assert.equal(capacity.document.cells.length, 100);
    assert.equal(capacity.document.cells[99].source.length, 64 * 1024);
    const unicode = document();
    unicode.cells[0].source = "あ".repeat(21845) + "x";
    await f.notebooks.create("local", f.project.id, {
      name: "UTF8 maximum",
      document: unicode,
    });
    unicode.cells[0].source += "y";
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "UTF8 excess",
        document: unicode,
      }),
      status(400),
    );
    const tooMany = structuredClone(maximum);
    tooMany.cells.push({ ...code, id: "cell-100" });
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "excess",
        document: tooMany,
      }),
      status(400),
    );
    const tooLong = document();
    tooLong.cells[0].source = "x".repeat(64 * 1024 + 1);
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "excess",
        document: tooLong,
      }),
      status(400),
    );
    const missingIds = document();
    const input = JSON.parse(JSON.stringify(missingIds));
    delete input.cells[0].id;
    const assigned = await f.notebooks.create("local", f.project.id, {
      name: "assigned",
      document: input,
    });
    assert.match(assigned.document.cells[0].id, /^[A-Za-z0-9_-]{1,64}$/);
    const response = await notebookRoutes(f.notebooks)(
      new Request(
        `http://localhost/api/projects/${f.project.id}/notebooks/${created.id}`,
        { headers: { Host: "localhost" } },
      ),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).chatId, f.project.chatId);
    const hostile = await notebookRoutes(f.notebooks)(
      new Request(`http://localhost/api/projects/${f.project.id}/notebooks`, {
        headers: { Host: "attacker.invalid" },
      }),
    );
    assert.equal(hostile.status, 403);
    const display = document();
    display.cells = [display.cells[0]];
    const outputCell = display.cells[0];
    assert.ok(outputCell.cell_type === "code");
    outputCell.outputs = [{ output_type: "stream", name: "stdout", text: "" }];
    const stdout = outputCell.outputs[0];
    assert.ok(stdout.output_type === "stream");
    const overhead = Buffer.byteLength(JSON.stringify(outputCell.outputs)) + 2;
    stdout.text = "a".repeat(2 * 1024 * 1024 - overhead);
    const bounded = await f.notebooks.create("local", f.project.id, {
      name: "display maximum",
      document: display,
    });
    assert.ok(bounded.document.cells[0].cell_type === "code");
    assert.equal(bounded.document.cells[0].outputs.length, 1);
    stdout.text += "x";
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "display excess",
        document: display,
      }),
      status(413),
    );
    const client = await connectDatabase(f.state, f.credentials, "application");
    f.cleanup.push(() => client.end());
    await assert.rejects(
      f.notebooks.createInTransaction(client, "local", f.project.id, {
        name: "unfenced",
        document: document(),
      }),
      status(503),
    );
    const rootR = document();
    rootR.metadata.kernelspec = { name: "ir", display_name: "R" };
    rootR.cells[0].metadata = { aira: { sharing: [] } };
    const inherited = await f.notebooks.create("local", f.project.id, {
      name: "R default",
      document: rootR,
    });
    assert.equal(
      (
        await f.notebooks.source(
          "local",
          f.project.id,
          inherited.id,
          "python-1",
        )
      ).language,
      "r",
    );
    const infoR = structuredClone(rootR);
    delete infoR.metadata.kernelspec;
    infoR.metadata.language_info = { name: "R" };
    const byInfo = await f.notebooks.create("local", f.project.id, {
      name: "R language info",
      document: infoR,
    });
    assert.equal(
      (await f.notebooks.source("local", f.project.id, byInfo.id, "python-1"))
        .language,
      "r",
    );
    const unknownKernel = structuredClone(rootR);
    unknownKernel.metadata.kernelspec = {
      name: "custom-unknown",
      display_name: "Unspecified",
    };
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "unknown kernel",
        document: unknownKernel,
      }),
      status(400),
    );
    const nullSettings = document();
    nullSettings.cells[0].metadata.aira = null;
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "invalid null settings",
        document: nullSettings,
      }),
      status(400),
    );
    const unsupported = structuredClone(rootR);
    unsupported.metadata.kernelspec = {
      name: "julia",
      display_name: "Julia",
      language: "Julia",
    };
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "unsupported default",
        document: unsupported,
      }),
      status(400),
    );
    const ambiguous = structuredClone(rootR);
    ambiguous.metadata.language_info = { name: "R" };
    ambiguous.metadata.kernelspec = {
      name: "python3",
      display_name: "Python",
      language: "python",
    };
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "conflicting language",
        document: ambiguous,
      }),
      status(400),
    );
    for (const [name, declared] of [
      ["ir", "python"],
      ["python3", "R"],
    ]) {
      const conflict = structuredClone(rootR);
      conflict.metadata.kernelspec = { name, display_name: name };
      conflict.metadata.language_info = { name: declared };
      await assert.rejects(
        f.notebooks.create("local", f.project.id, {
          name: "kernel-name conflict",
          document: conflict,
        }),
        status(400),
      );
    }
    const consistent = structuredClone(rootR);
    consistent.metadata.kernelspec = {
      name: "ir",
      display_name: "R",
      language: "R",
    };
    consistent.metadata.language_info = { name: "R" };
    await assert.doesNotReject(
      f.notebooks.create("local", f.project.id, {
        name: "consistent R kernel",
        document: consistent,
      }),
    );
    const lines = ["あ".repeat(21845), "x"];
    const streamed = {
      ...document(),
      cells: [
        {
          ...code,
          source: lines,
          outputs: [
            {
              output_type: "stream",
              name: "stdout",
              text: ["first\n", "second\n"],
            },
          ],
        },
        {
          ...document().cells[3],
          attachments: {
            "plot.svg": { "image/svg+xml": "<svg>inert literal</svg>" },
          },
        },
      ],
    };
    let normalized: Notebook | undefined;
    await assert.doesNotReject(async () => {
      normalized = await f.notebooks.create("local", f.project.id, {
        name: "nbformat lines and attachments",
        document: streamed,
      });
    });
    assert.ok(normalized);
    assert.equal(normalized.document.cells[0].source, lines.join(""));
    const streamCell = normalized.document.cells[0];
    assert.ok(streamCell.cell_type === "code");
    assert.deepEqual(streamCell.outputs, [
      { output_type: "stream", name: "stdout", text: "first\nsecond\n" },
    ]);
    assert.deepEqual(normalized.document.cells[1], streamed.cells[1]);
    streamed.cells[0].source = [...lines, "y"];
    await assert.rejects(
      f.notebooks.create("local", f.project.id, {
        name: "array source excess",
        document: streamed,
      }),
      status(400),
    );
  },
);
/** @id TEST-NOTE-002 @verifies REQ-NOTE-002 */
test(
  "TEST-NOTE-002 optimistic source saves and concurrent stale409 preserve complete current bytes",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    let created: Notebook | undefined;
    await assert.doesNotReject(async () => {
      created = await f.notebooks.create("local", f.project.id, {
        name: "revisions",
        document: document(),
      });
    });
    assert.ok(created);
    const a = structuredClone(created.document),
      b = structuredClone(created.document);
    a.cells[0].source = "revision A";
    b.cells[0].source = "revision B";
    for (const candidate of [a, b])
      candidate.metadata.aira = {
        project_id: f.project.id.toUpperCase(),
        chat_id: created.chatId.toUpperCase(),
        notebook_id: created.id.toUpperCase(),
      };
    assert.ok(
      a.cells[0].cell_type === "code" && b.cells[0].cell_type === "code",
    );
    a.cells[0].outputs = b.cells[0].outputs = [
      {
        output_type: "stream",
        name: "stdout",
        text: "inert stored display fixture",
      },
    ];
    const results = await Promise.allSettled([
      f.notebooks.save("local", f.project.id, created.id, {
        revision: 1,
        document: a,
      }),
      f.notebooks.save("local", f.project.id, created.id, {
        revision: 1,
        document: b,
      }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.ok(status(409)(rejected[0].reason));
    const current = await f.notebooks.get("local", f.project.id, created.id);
    assert.equal(current.revision, 2);
    assert.ok(current.document.cells[0].cell_type === "code");
    assert.deepEqual(current.document.cells[0].outputs, [
      {
        output_type: "stream",
        name: "stdout",
        text: "inert stored display fixture",
      },
    ]);
    await assert.rejects(
      f.notebooks.save("local", f.project.id, created.id, {
        revision: 1,
        document: document(),
      }),
      status(409),
    );
    assert.deepEqual(
      await f.notebooks.get("local", f.project.id, created.id),
      current,
    );
    const app = await connectDatabase(f.state, f.credentials, "application");
    f.cleanup.push(() => app.end());
    await assert.rejects(
      f.notebooks.saveInTransaction(app, "local", f.project.id, created.id, {
        revision: current.revision,
        document: current.document,
      }),
      status(503),
    );
  },
);
/** @id TEST-NOTE-003 @verifies REQ-NOTE-003 */
test(
  "TEST-NOTE-003 real owned kernel invalidation, retained native errors/artifacts and stale completion409",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    let notebook: Notebook | undefined;
    await assert.doesNotReject(async () => {
      notebook = await f.notebooks.create("local", f.project.id, {
        name: "executions",
        document: document(),
      });
    });
    assert.ok(notebook);
    const other = await f.notebooks.create("local", f.project.id, {
      name: "unrelated",
      document: document(),
    });
    const a = await testContainer(f.credentials),
      b = await testContainer(f.credentials);
    f.cleanup.push(
      () => removeOwned(a),
      () => removeOwned(b),
    );
    f.kernels.set(notebook.id, a);
    f.kernels.set(other.id, b);
    const first = await f.run(notebook, a.resourceId);
    const rejectedArtifact = await f.provenance.prepareArtifact(
      "local",
      f.project.id,
      "wrong-scope.txt",
      "text/plain",
      (async function* () {
        yield Buffer.from("never published");
      })(),
    );
    await assert.rejects(
      f.notebooks.completeRun("local", f.project.id, other.id, first.id, {
        status: "completed",
        outputs: [],
        artifacts: [rejectedArtifact],
      }),
      status(404),
    );
    await assert.rejects(
      f.files.get("local", f.project.id, rejectedArtifact.id),
      status(404),
    );
    assert.equal(
      (await f.provenance.get("local", f.project.id, first.id)).status,
      "running",
    );
    const app = await connectDatabase(f.state, f.credentials, "application");
    f.cleanup.push(() => app.end());
    assert.equal(
      Number(
        (
          await app.query(
            "SELECT count(*) FROM file_reservations WHERE project_id=$1",
            [f.project.id],
          )
        ).rows[0].count,
      ),
      0,
    );
    let completed: Notebook | undefined;
    await assert.doesNotReject(async () => {
      completed = await f.notebooks.completeRun(
        "local",
        f.project.id.toUpperCase(),
        first.notebookId.toUpperCase(),
        first.id,
        {
          status: "completed",
          outputs: [
            {
              output_type: "stream",
              name: "stdout",
              text: "observed fixture output\n",
            },
            {
              output_type: "execute_result",
              execution_count: 17,
              data: { "text/plain": "17" },
              metadata: {},
            },
          ],
          artifacts: [],
        },
      );
    });
    assert.ok(completed);
    assert.equal(completed.results["python-1"].runId, first.id);
    assert.equal(completed.results["python-1"].stale, false);
    assert.equal(completed.results["python-1"].lostState, false);
    const current = completed.document.cells[0];
    assert.ok(current.cell_type === "code");
    assert.deepEqual(current.outputs, [
      {
        output_type: "stream",
        name: "stdout",
        text: "observed fixture output\n",
      },
      {
        output_type: "execute_result",
        execution_count: 17,
        data: { "text/plain": "17" },
        metadata: {},
      },
    ]);
    assert.equal(
      current.execution_count,
      17,
      "retain observed count, never cell position",
    );
    const errorRun = await f.run(completed, a.resourceId);
    const failure = [
      {
        output_type: "error" as const,
        ename: "FixtureError",
        evalue: "failure",
        traceback: ["fixture"],
      },
    ];
    const failed = await f.notebooks.completeRun(
      "local",
      f.project.id,
      notebook.id,
      errorRun.id,
      { status: "failed", outputs: failure, artifacts: [] },
    );
    assert.deepEqual(failed.results["python-1"].currentOutputs, failure);
    const errorCell = failed.document.cells[0];
    assert.ok(errorCell.cell_type === "code");
    assert.equal(
      errorCell.execution_count,
      null,
      "missing count is not inferred from a prior run",
    );
    const staleRun = await f.run(failed, a.resourceId);
    const changed = structuredClone(failed.document);
    changed.cells[0].source = "new source must survive";
    const saved = await f.notebooks.save("local", f.project.id, notebook.id, {
      revision: failed.revision,
      document: changed,
    });
    const file = await f.provenance.prepareArtifact(
      "local",
      f.project.id,
      "historical.txt",
      "text/plain",
      (async function* () {
        yield Buffer.from("historical");
      })(),
    );
    await assert.rejects(
      f.notebooks.completeRun("local", f.project.id, notebook.id, staleRun.id, {
        status: "completed",
        outputs: [
          {
            output_type: "stream",
            name: "stdout",
            text: "old source completed",
          },
        ],
        artifacts: [file],
      }),
      status(409),
    );
    assert.deepEqual(f.invalidations, [
      { id: notebook.id, epoch: a.resourceId },
    ]);
    assert.equal((await inspectOwned(a)).State.Running, false);
    assert.equal((await inspectOwned(b)).State.Running, true);
    const latest = await f.notebooks.get("local", f.project.id, notebook.id);
    assert.equal(latest.revision, saved.revision);
    assert.equal(latest.document.cells[0].source, "new source must survive");
    assert.equal(latest.results["python-1"].stale, true);
    assert.equal(latest.results["python-1"].lostState, true);
    const history = await f.notebooks.history(
      "local",
      f.project.id,
      notebook.id,
    );
    assert.equal(history.length, 3);
    assert.equal(history[0].id, staleRun.id);
    assert.equal(history[0].status, "completed");
    assert.deepEqual(history[0].artifactIds, [file.id]);
    assert.deepEqual(
      history.find((r) => r.id === errorRun.id)?.outputs,
      failure,
    );
    await f.notebooks.close();
    const reopened = new Notebooks(
      f.operations,
      f.provenance,
      f.runtime,
      f.state,
      f.credentials,
    );
    f.cleanup.push(() => reopened.close());
    assert.equal(
      (await reopened.get("local", f.project.id, notebook.id)).document.cells[0]
        .source,
      "new source must survive",
    );
    assert.equal(
      (await reopened.history("local", f.project.id, notebook.id)).length,
      3,
    );
  },
);
