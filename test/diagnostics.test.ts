import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { testDatabase } from "./helpers/database";
import { Operations } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { Files } from "../src/server/files";
import { FileStorage, storageDirectory } from "../src/server/file-storage";
import { Provenance } from "../src/server/provenance";
import { Notebooks } from "../src/server/notebooks";
import { Proposals } from "../src/server/proposals";
import { Confirmations } from "../src/server/confirmations";
import { connectDatabase } from "../src/server/database";
import { DATABASE_IMAGE } from "../src/server/db-container";
import {
  docker,
  inspectOwned,
  removeOwned,
} from "../src/server/owned-containers";
import { Diagnostics } from "../src/server/diagnostics";
import { DiagnosticEvents, type DiagnosticEvent } from "../src/server/events";
import { diagnosticRoutes } from "../src/server/diagnostic-routes";
import { ServiceError } from "../src/server/http";
import { backup } from "../scripts/backup";
import { restoreValidation } from "../scripts/restore-validation";

const imageDigest =
  "sha256:ca17b3e0cfba612f32a53005f2aaa7cdc5b8fb3bd2c13e86edae7b41de3c148a";
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const status = (n: number) => (error: unknown) =>
  error instanceof ServiceError && error.status === n;
async function fixture(t: TestContext) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "DIAGNOSTIC_TEST_CLEANUP");
  });
  const db = await testDatabase();
  cleanup.push(() => db.cleanup());
  const operations = new Operations(db.state, db.credentials);
  cleanup.push(() => operations.close());
  await operations.acquire();
  const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
  cleanup.push(() => admin.end());
  return { ...db, operations, admin, cleanup };
}
/** @id TEST-DIAG-001 @verifies REQ-DIAG-001 */
test(
  "TEST-DIAG-001 actual scoped readiness/role/lease errors with sentinel-secret/prompt redaction",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const logged: DiagnosticEvent[] = [];
    const events = new DiagnosticEvents((event) => logged.push(event));
    const options = {
      imageDigest,
      events,
      async auth() {
        return { isAuthenticated: true };
      },
    };
    const diagnostics = new Diagnostics(
      f.state,
      f.credentials,
      f.operations,
      options,
    );
    const ready = await diagnostics.readiness();
    assert.equal(ready.ready, true);
    assert.equal(ready.events.length, 7);
    assert.ok(ready.events.every((event) => event.status === "ready"));
    for (const event of ready.events) {
      assert.match(event.id, /^[a-f0-9-]{36}$/);
      assert.ok(Number.isFinite(Date.parse(event.timestamp)));
      assert.ok(event.code && event.action);
    }
    const route = diagnosticRoutes(diagnostics);
    assert.equal(
      (
        await route(
          new Request("http://127.0.0.1/api/readiness", {
            headers: { Host: "127.0.0.1", Origin: "https://foreign.test" },
          }),
        )
      ).status,
      403,
    );
    const response = await route(
      new Request("http://127.0.0.1/api/readiness", {
        headers: { Host: "127.0.0.1" },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const sentinel = `PROMPT_SENTINEL_${randomUUID()}_${f.credentials.application}`;
    const failed = await new Diagnostics(f.state, f.credentials, f.operations, {
      ...options,
      cli: "/no-such-aira-copilot",
      imageDigest: "sha256:" + "0".repeat(64),
      async auth() {
        throw new Error(sentinel);
      },
    }).readiness();
    assert.equal(failed.ready, false);
    for (const component of ["cli", "auth", "image"])
      assert.notEqual(
        failed.events.find((event) => event.component === component)?.status,
        "ready",
      );
    const unauthenticated = await new Diagnostics(
      f.state,
      f.credentials,
      f.operations,
      {
        ...options,
        async auth() {
          return { isAuthenticated: false };
        },
      },
    ).readiness();
    assert.equal(
      unauthenticated.events.find((event) => event.component === "auth")
        ?.status,
      "blocked",
    );
    const unknown = await new Diagnostics(
      f.state,
      f.credentials,
      undefined,
      options,
    ).readiness();
    assert.equal(unknown.ready, false);
    assert.equal(
      unknown.events.find((event) => event.component === "lease")?.status,
      "unknown",
    );
    await f.admin.query("ALTER ROLE aira_application CREATEDB");
    try {
      const elevated = await diagnostics.readiness();
      assert.equal(elevated.ready, false);
      assert.equal(
        elevated.events.find((event) => event.component === "role")?.status,
        "blocked",
      );
    } finally {
      await f.admin.query("ALTER ROLE aira_application NOCREATEDB");
    }
    await f.admin.query("GRANT pg_read_all_data TO aira_application");
    try {
      const elevated = await diagnostics.readiness();
      assert.equal(elevated.ready, false);
      assert.equal(
        elevated.events.find((event) => event.component === "role")?.status,
        "blocked",
      );
    } finally {
      await f.admin.query("REVOKE pg_read_all_data FROM aira_application");
    }
    await f.admin.query("GRANT CREATE ON SCHEMA public TO aira_application");
    try {
      const elevated = await diagnostics.readiness();
      assert.equal(elevated.ready, false);
      assert.equal(
        elevated.events.find((event) => event.component === "role")?.status,
        "blocked",
      );
    } finally {
      await f.admin.query(
        "REVOKE CREATE ON SCHEMA public FROM aira_application",
      );
    }
    await f.admin.query("UPDATE writer_control SET epoch=epoch+1");
    const lost = await diagnostics.readiness();
    assert.equal(lost.ready, false);
    assert.equal(
      lost.events.find((event) => event.component === "lease")?.status,
      "blocked",
    );
    const write = f.operations.write.bind(f.operations);
    f.operations.write = async () => {
      throw new Error(sentinel);
    };
    let infrastructureFailure: Awaited<ReturnType<Diagnostics["readiness"]>>;
    try {
      infrastructureFailure = await diagnostics.readiness();
      assert.equal(infrastructureFailure.ready, false);
      assert.equal(
        infrastructureFailure.events.find(
          (event) => event.component === "lease",
        )?.status,
        "unknown",
      );
    } finally {
      f.operations.write = write;
    }
    const unavailable = await new Diagnostics(
      join(f.state, "absent"),
      f.credentials,
      undefined,
      options,
    ).readiness();
    assert.equal(unavailable.ready, false);
    assert.notEqual(
      unavailable.events.find((event) => event.component === "socket")?.status,
      "ready",
    );
    events.failure();
    const payload = JSON.stringify({
      ready,
      failed,
      infrastructureFailure,
      unavailable,
      logged,
    });
    for (const forbidden of [
      sentinel,
      f.credentials.bootstrap,
      f.credentials.migration,
      f.credentials.application,
    ])
      assert.ok(!payload.includes(forbidden));
    assert.ok(
      logged.some(
        (event) =>
          event.component === "operation" && event.status === "blocked",
      ),
    );
  },
);
/** @id TEST-DIAG-002 @verifies REQ-DIAG-002 */
test(
  "TEST-DIAG-002 quiescent DB-plus-blobs independent restore; hashes/exact-one/inert identities",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t);
    const parent = await mkdtemp(join(resolve(".scratch"), "d-"));
    f.cleanup.push(() => rm(parent, { recursive: true }));
    const archive = join(parent, "backup"),
      destination = join(parent, "restored");
    await assert.rejects(backup(f.state, archive), status(409));
    const sessions = new Sessions(f.operations, f.state, f.credentials);
    f.cleanup.push(() => sessions.close());
    const project = await sessions.createProject("local", "Backup research");
    const storage = new FileStorage(await storageDirectory(f.state));
    await storage.initialize();
    const files = new Files(f.operations, storage, f.state, f.credentials);
    f.cleanup.push(() => files.close());
    const bytes = Buffer.from("restored research bytes\u0000😀");
    const file = await files.upload(
      "local",
      project.id,
      "data.txt",
      "text/plain",
      (async function* () {
        yield bytes;
      })(),
    );
    const provenance = new Provenance(
      f.operations,
      files,
      f.state,
      f.credentials,
    );
    f.cleanup.push(() => provenance.close());
    const notebooks = new Notebooks(
      f.operations,
      provenance,
      {
        async epoch() {
          return null;
        },
        async invalidate() {
          assert.fail("Backup must not touch source runtime");
        },
      },
      f.state,
      f.credentials,
    );
    f.cleanup.push(() => notebooks.close());
    const notebook = await notebooks.create("local", project.id, {
      name: "Preserved notebook",
      document: {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            id: "Code-A",
            cell_type: "code",
            source: "print(42)",
            metadata: { aira: { language: "python", sharing: [] } },
            outputs: [],
            execution_count: null,
          },
        ],
      },
    });
    const proposals = new Proposals(
      f.operations,
      notebooks,
      f.state,
      f.credentials,
    );
    f.cleanup.push(() => proposals.close());
    const proposed = await proposals.propose("local", project.id, {
      kind: "change-cell",
      notebookId: notebook.id,
      revision: notebook.revision,
      cell: {
        id: "Code-A",
        cell_type: "code",
        source: "print(43)",
        language: "python",
        sharing: [],
      },
    });
    const fingerprint = hash(randomUUID());
    const grantId = await f.operations.grant("local", "execution", fingerprint);
    const job = await f.operations.admit(
      {
        actor: "local",
        requestId: randomUUID(),
        purpose: "execution",
        fingerprint,
        grantId,
      },
      project.id,
    );
    const kernelEpoch = randomUUID();
    const run = await provenance.capture("local", project.id, {
      jobId: job.id,
      notebookId: notebook.id,
      cellId: "Code-A",
      revision: notebook.revision,
      source: "print(42)",
      language: "python",
      sharing: [],
      inputs: [],
      environment: null,
      kernelEpoch,
    });
    await f.operations.dispatch("local", job.id);
    const resourceId = kernelEpoch;
    const id = await docker([
      "create",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--label",
      `aira.application=${f.credentials.applicationId}`,
      "--label",
      `aira.control=${f.credentials.controlId}`,
      "--label",
      `aira.resource=${resourceId}`,
      "--entrypoint",
      "sleep",
      DATABASE_IMAGE,
      "600",
    ]);
    const witness = {
      id,
      applicationId: f.credentials.applicationId,
      controlId: f.credentials.controlId,
      resourceId,
    };
    f.cleanup.push(() => removeOwned(witness));
    await docker(["start", id]);
    await f.admin.query(
      "INSERT INTO operation_containers(id,application_id,control_id,resource_id,job_id) VALUES($1,$2,$3,$4,$5)",
      [id, witness.applicationId, witness.controlId, resourceId, job.id],
    );
    await f.admin.query(
      `INSERT INTO runtime_containers(kernel_epoch,notebook_id,actor,project_id,application_id,control_id,image_digest,container_id,state,inputs,writer_epoch)
       VALUES($1,$2,'local',$3,$4,$5,$6,$7,'ready','[]',(SELECT epoch FROM writer_control))`,
      [
        kernelEpoch,
        notebook.id,
        project.id,
        witness.applicationId,
        witness.controlId,
        imageDigest,
        witness.id,
      ],
    );
    await f.admin.query(
      "INSERT INTO runtime_job_bindings(job_id,kernel_epoch) VALUES($1,$2)",
      [job.id, kernelEpoch],
    );
    await f.admin.query(
      "INSERT INTO runtime_reservations(notebook_id,kernel_epoch,image_digest,writer_epoch,state) VALUES($1,$2,$3,(SELECT epoch FROM writer_control),'ready')",
      [notebook.id, kernelEpoch, imageDigest],
    );
    await f.admin.query(
      "INSERT INTO file_reservations(id,project_id,actor,epoch,bytes) VALUES($1,$2,'local',(SELECT epoch FROM writer_control),17)",
      [randomUUID(), project.id],
    );
    const confirmations = new Confirmations(
      f.operations,
      notebooks,
      files,
      provenance,
      f.state,
      f.credentials,
      { imageDigest },
    );
    f.cleanup.push(() => confirmations.close());
    const confirmation = await confirmations.prepareExecution(
      "local",
      project.id,
      {
        notebookId: notebook.id,
        cellId: "Code-A",
        revision: notebook.revision,
        inputs: [],
      },
    );
    const sourceCredentials = await readFile(join(f.state, "credentials.json"));
    await f.operations.close();
    const sourceTables = [
      "projects",
      "chats",
      "notebooks",
      "notebook_links",
      "runs",
      "jobs",
      "grants",
      "proposal_changes",
      "file_versions",
      "writer_control",
      "operation_containers",
      "runtime_containers",
      "runtime_job_bindings",
      "runtime_reservations",
      "file_reservations",
      "confirmations",
    ];
    async function snapshot() {
      const result: Record<string, unknown> = {};
      for (const table of sourceTables)
        result[table] = (
          await f.admin.query(
            `SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
          )
        ).rows;
      return result;
    }
    const before = await snapshot();
    await assert.rejects(
      backup(f.state, join(f.state, "..backup")),
      (error: unknown) =>
        error instanceof ServiceError && error.code === "BACKUP_SOURCE_OVERLAP",
    );
    const manifest = await backup(f.state, archive);
    assert.equal(manifest.blobs.length, 1);
    assert.equal(manifest.blobs[0].sha256, file.sha256);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      await readFile(join(f.state, "credentials.json")),
      sourceCredentials,
    );
    assert.equal((await inspectOwned(witness)).State.Running, true);
    assert.deepEqual(await readFile(storage.path(file.blobId)), bytes);
    const dump = await readFile(join(archive, "research.dump"));
    const archivedManifest = await readFile(
      join(archive, "manifest.json"),
      "utf8",
    );
    for (const secret of [
      f.credentials.bootstrap,
      f.credentials.application,
      f.credentials.migration,
    ]) {
      assert.ok(!archivedManifest.includes(secret));
      assert.ok(!dump.includes(Buffer.from(secret)));
    }
    await assert.rejects(restoreValidation(archive, f.state), status(409));
    await writeFile(
      join(archive, "manifest.json"),
      JSON.stringify({ ...manifest, schemaSha256: "0".repeat(64) }),
      { mode: 0o600 },
    );
    await assert.rejects(restoreValidation(archive, destination), status(409));
    await writeFile(join(archive, "manifest.json"), archivedManifest, {
      mode: 0o600,
    });
    const changedDump = Buffer.from(dump);
    changedDump[0] ^= 1;
    await writeFile(join(archive, "research.dump"), changedDump, {
      mode: 0o600,
    });
    await assert.rejects(restoreValidation(archive, destination), status(503));
    await writeFile(join(archive, "research.dump"), dump, { mode: 0o600 });
    const corrupt = join(archive, "blobs", file.blobId);
    await writeFile(corrupt, Buffer.from("tampered"), { mode: 0o600 });
    await assert.rejects(restoreValidation(archive, destination), status(503));
    await writeFile(corrupt, bytes, { mode: 0o600 });
    const restored = await restoreValidation(archive, destination);
    f.cleanup.push(() => removeOwned(restored.identity));
    assert.notEqual(
      restored.credentials.applicationId,
      f.credentials.applicationId,
    );
    assert.notEqual(restored.credentials.controlId, f.credentials.controlId);
    for (const role of ["bootstrap", "application", "migration"] as const)
      assert.notEqual(restored.credentials[role], f.credentials[role]);
    const restoredAdmin = await connectDatabase(
      destination,
      restored.credentials,
      "bootstrap",
    );
    f.cleanup.push(() => restoredAdmin.end());
    const restoredStorage = new FileStorage(join(destination, "files"));
    assert.deepEqual(await readFile(restoredStorage.path(file.blobId)), bytes);
    const exact = await restoredAdmin.query(
      "SELECT p.id,p.chat_id,c.id AS actual_chat,(SELECT count(*)::integer FROM chats WHERE project_id=p.id) AS count FROM projects p JOIN chats c ON c.project_id=p.id",
    );
    assert.equal(exact.rows.length, 1);
    assert.equal(exact.rows[0].count, 1);
    assert.equal(exact.rows[0].chat_id, exact.rows[0].actual_chat);
    assert.equal(exact.rows[0].id, project.id);
    assert.deepEqual(
      (
        await restoredAdmin.query(
          "SELECT document FROM notebooks WHERE id=$1",
          [notebook.id],
        )
      ).rows[0].document,
      notebook.document,
    );
    assert.equal(
      (
        await restoredAdmin.query("SELECT source FROM runs WHERE id=$1", [
          run.id,
        ])
      ).rows[0].source,
      "print(42)",
    );
    assert.equal(
      (
        await restoredAdmin.query(
          "SELECT state FROM proposal_changes WHERE id=$1",
          [proposed.id],
        )
      ).rows[0].state,
      "pending",
    );
    const interrupted = (
      await restoredAdmin.query("SELECT state,cleanup FROM jobs WHERE id=$1", [
        job.id,
      ])
    ).rows[0];
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.cleanup, "unknown");
    assert.equal(
      (
        await restoredAdmin.query(
          "SELECT count(*)::integer AS n FROM grants WHERE expires_at>clock_timestamp()",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await restoredAdmin.query(
          "SELECT revoked FROM confirmations WHERE id=$1",
          [confirmation.id],
        )
      ).rows[0].revoked,
      true,
    );
    for (const table of [
      "operation_containers",
      "runtime_containers",
      "runtime_job_bindings",
      "runtime_reservations",
      "file_reservations",
    ])
      assert.equal(
        (
          await restoredAdmin.query(
            `SELECT count(*)::integer AS n FROM ${table}`,
          )
        ).rows[0].n,
        0,
      );
    const audit = JSON.parse(
      await readFile(join(destination, "restore-audit.json"), "utf8"),
    );
    assert.equal(audit.inert.operation_containers[0].id, witness.id);
    assert.equal(audit.inert.operation_containers[0].stopped, false);
    assert.equal(audit.inert.runtime_containers[0].container_id, witness.id);
    assert.equal(audit.inert.runtime_containers[0].state, "ready");
    assert.equal(audit.inert.runtime_job_bindings[0].job_id, job.id);
    assert.equal(audit.inert.runtime_reservations[0].notebook_id, notebook.id);
    assert.equal(audit.inert.file_reservations[0].bytes, "17");
    const restoredOperations = new Operations(
      destination,
      restored.credentials,
    );
    f.cleanup.push(() => restoredOperations.close());
    await restoredOperations.acquire();
    assert.equal((await inspectOwned(witness)).State.Running, true);
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(restoreValidation(archive, destination), status(409));
    assert.ok(!(await readdir(archive)).includes("credentials.json"));
    await mkdir(join(parent, "nonempty"), { mode: 0o700 });
    await writeFile(join(parent, "nonempty", "preserve"), "untouched", {
      mode: 0o600,
    });
    await assert.rejects(
      restoreValidation(archive, join(parent, "nonempty")),
      status(409),
    );
    assert.equal(
      await readFile(join(parent, "nonempty", "preserve"), "utf8"),
      "untouched",
    );
  },
);
