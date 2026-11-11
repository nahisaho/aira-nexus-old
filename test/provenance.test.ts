import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testDatabase } from "./helpers/database";
import { connectDatabase } from "../src/server/database";
import { Operations } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { Files } from "../src/server/files";
import { FileStorage, storageDirectory } from "../src/server/file-storage";
import { Provenance, type ArtifactRecord } from "../src/server/provenance";
import {
  projectRun,
  type CaptureInput,
  type CapturedRun,
} from "../src/server/run-snapshots";
import { ServiceError } from "../src/server/http";
const status = (n: number) => (e: unknown) =>
  e instanceof ServiceError && e.status === n;
async function* bytes(text: string) {
  yield Buffer.from(text);
}
async function fixture(t: TestContext) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const action of cleanup.reverse()) await action();
  });
  const db = await testDatabase();
  cleanup.push(() => db.cleanup());
  const operations = new Operations(db.state, db.credentials);
  cleanup.push(() => operations.close());
  await operations.acquire();
  const sessions = new Sessions(operations, db.state, db.credentials);
  cleanup.push(() => sessions.close());
  const project = await sessions.createProject("local", "provenance fixture");
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
  const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
  cleanup.push(() => admin.end());
  const notebookId = randomUUID(),
    cellId = "cell_source-1";
  await admin.query(
    "INSERT INTO notebook_links(id,project_id,chat_id,actor) VALUES($1,$2,$3,'local')",
    [notebookId, project.id, project.chatId],
  );
  async function intent(): Promise<CaptureInput> {
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
    return {
      jobId: job.id,
      notebookId,
      cellId,
      revision: 1,
      source: "print('first')",
      language: "python",
      sharing: [{ name: "x", direction: "python-to-r", family: "array" }],
      inputs: [],
      kernelEpoch: randomUUID(),
      environment: {
        imageDigest: "sha256:" + "a".repeat(64),
        python: "synthetic-python",
        r: "synthetic-R",
        packages: { "python:numpy": "observed-fixture", "r:optional": null },
      },
    };
  }
  return {
    ...db,
    operations,
    sessions,
    project,
    storage,
    files,
    provenance,
    admin,
    notebookId,
    cellId,
    intent,
    cleanup,
  };
}
/** @id TEST-PROV-001 @verifies REQ-PROV-001 */
test(
  "TEST-PROV-001 immutable pre-dispatch owned source/input/environment and observed terminal times survive restart",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const input = await f.intent();
    const selected = await f.files.upload(
      "local",
      f.project.id,
      "input.csv",
      "text/csv",
      bytes("x\n1"),
    );
    input.inputs = [{ id: selected.id, name: "input.csv" }];
    const expected = structuredClone(input);
    let run: CapturedRun | undefined;
    await assert.doesNotReject(async () => {
      run = await f.provenance.capture("local", f.project.id, input);
    });
    assert.ok(run);
    assert.equal(
      (await f.operations.get("local", input.jobId)).state,
      "queued",
    );
    input.source = "changed";
    input.environment!.packages["python:numpy"] = "changed";
    await f.files.upload(
      "local",
      f.project.id,
      "input.csv",
      "text/csv",
      bytes("x\n2"),
    );
    assert.equal(run.source, expected.source);
    assert.deepEqual(run.environment, expected.environment);
    assert.deepEqual(run.sharing, expected.sharing);
    assert.deepEqual(run.inputs, [
      {
        id: selected.id,
        workspaceName: "input.csv",
        size: selected.size,
        sha256: selected.sha256,
      },
    ]);
    assert.equal(run.chatId, f.project.chatId);
    assert.equal(run.dispatchedAt, null);
    await f.operations.dispatch("local", input.jobId);
    await f.operations.observeStarted("local", input.jobId);
    const outputs = [
      {
        output_type: "stream" as const,
        name: "stdout" as const,
        text: "first\n",
      },
    ];
    const finished = await f.provenance.finish("local", f.project.id, run.id, {
      status: "completed",
      outputs,
      artifacts: [],
    });
    assert.equal(finished.status, "completed");
    assert.deepEqual(finished.outputs, outputs);
    for (const time of [
      finished.createdAt,
      finished.dispatchedAt,
      finished.startedAt,
      finished.endedAt,
    ])
      assert.ok(time && Number.isFinite(Date.parse(time)));
    await f.provenance.close();
    const reopened = new Provenance(
      f.operations,
      f.files,
      f.state,
      f.credentials,
    );
    f.cleanup.push(() => reopened.close());
    assert.deepEqual(
      await reopened.get("local", f.project.id, run.id),
      finished,
    );
    const invalid = await f.intent();
    await f.operations.dispatch("local", invalid.jobId);
    await assert.rejects(
      reopened.capture("local", f.project.id, invalid),
      status(409),
    );
    await assert.rejects(
      reopened.get("other", f.project.id, run.id),
      status(404),
    );
    const foreign = await f.sessions.createProject("other", "foreign");
    const foreignFile = await f.files.upload(
      "other",
      foreign.id,
      "private.csv",
      "text/csv",
      bytes("private"),
    );
    const wrong = await f.intent();
    wrong.inputs = [{ id: foreignFile.id, name: "private.csv" }];
    await assert.rejects(
      reopened.capture("local", f.project.id, wrong),
      status(404),
    );
    const invalidCapture = await f.intent();
    for (const source of ["\0", "\uD800"]) {
      await assert.rejects(
        reopened.capture("local", f.project.id, { ...invalidCapture, source }),
        status(400),
      );
    }
    for (const cellId of ["bad/id", "a".repeat(65)]) {
      await assert.rejects(
        reopened.capture("local", f.project.id, { ...invalidCapture, cellId }),
        status(400),
      );
    }
    const app = await connectDatabase(f.state, f.credentials, "application");
    try {
      await assert.rejects(
        app.query("UPDATE runs SET source='invented' WHERE id=$1", [run.id]),
        (e) => e instanceof Error && "code" in e && e.code === "42501",
      );
    } finally {
      await app.end();
    }
  },
);
/** @id TEST-PROV-002 @verifies REQ-PROV-002 */
test(
  "TEST-PROV-002 byte-first publication, exact origins, atomic rollback and uncertain COMMIT retention",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.files.upload(
      "local",
      f.project.id,
      "same.txt",
      "text/plain",
      bytes("old"),
    );
    const write = f.operations.write.bind(f.operations);
    let armed = true;
    f.operations.write = async (action) => {
      const result = await write(action);
      if (armed && result && typeof result === "object" && "blobId" in result) {
        armed = false;
        throw new Error("owned synthetic lost COMMIT acknowledgement");
      }
      return result;
    };
    try {
      await assert.rejects(
        f.files.upload(
          "local",
          f.project.id,
          "same.txt",
          "text/plain",
          bytes("new"),
        ),
        /lost COMMIT acknowledgement/,
      );
    } finally {
      f.operations.write = write;
    }
    const committed = await f.files.list("local", f.project.id);
    assert.equal(committed.length, 2);
    for (const file of committed)
      await assert.doesNotReject(
        f.storage.verify(file.blobId, file.size, file.sha256),
      );
    let original: ArtifactRecord | undefined;
    await assert.doesNotReject(async () => {
      original = await f.provenance.artifact("local", f.project.id, first.id);
    });
    assert.ok(original);
    assert.equal(original.origin.kind, "upload");
    assert.equal(original.origin.chatId, f.project.chatId);
    assert.equal(original.origin.notebookId, null);
    assert.equal(
      original.sha256,
      createHash("sha256").update("old").digest("hex"),
    );
    assert.ok(Number.isFinite(Date.parse(original.createdAt)));
    const input = await f.intent();
    let run: CapturedRun | undefined;
    await assert.doesNotReject(async () => {
      run = await f.provenance.capture("local", f.project.id, input);
    });
    assert.ok(run);
    await f.operations.dispatch("local", input.jobId);
    await f.operations.observeStarted("local", input.jobId);
    const prepared = await f.provenance.prepareArtifact(
      "local",
      f.project.id,
      "generated.txt",
      "text/plain",
      bytes("generated"),
    );
    const unfenced = await connectDatabase(
      f.state,
      f.credentials,
      "application",
    );
    try {
      await assert.rejects(
        f.files.commitPrepared(unfenced, prepared),
        status(503),
      );
    } finally {
      await unfenced.end();
    }
    const borrowed = await f.operations.write(async (client) => client);
    await assert.rejects(
      f.files.commitPrepared(borrowed, prepared),
      status(503),
    );
    await assert.rejects(
      f.files.get("local", f.project.id, prepared.id),
      status(404),
    );
    await assert.rejects(
      f.provenance.finish("local", f.project.id, run.id, {
        status: "completed",
        outputs: [],
        artifacts: [{ ...prepared, name: "../escape" }],
      }),
      status(400),
    );
    const failed = await f.provenance.finish("local", f.project.id, run.id, {
      status: "failed",
      artifacts: [prepared],
      outputs: [
        {
          output_type: "error",
          ename: "FixtureError",
          evalue: "observed failure",
          traceback: ["fixture"],
        },
      ],
    });
    assert.equal(failed.status, "failed");
    const generated = await f.provenance.artifact(
      "local",
      f.project.id,
      prepared.id,
    );
    assert.equal(generated.origin.runId, run.id);
    assert.equal(generated.origin.notebookId, f.notebookId);
    assert.equal(generated.origin.status, "failed");
    assert.deepEqual(
      await f.provenance.artifact("local", f.project.id, first.id),
      original,
    );
    const damaged = await f.intent();
    const damagedRun = await f.provenance.capture(
      "local",
      f.project.id,
      damaged,
    );
    await f.operations.dispatch("local", damaged.jobId);
    await f.operations.observeStarted("local", damaged.jobId);
    const damagedFile = await f.provenance.prepareArtifact(
      "local",
      f.project.id,
      "damaged.txt",
      "text/plain",
      bytes("sealed"),
    );
    await writeFile(f.storage.path(damagedFile.blobId), "changed", {
      mode: 0o600,
    });
    await assert.rejects(
      f.provenance.finish("local", f.project.id, damagedRun.id, {
        status: "completed",
        outputs: [],
        artifacts: [damagedFile],
      }),
      status(503),
    );
    await assert.rejects(
      f.files.get("local", f.project.id, damagedFile.id),
      status(404),
    );
    const invalidOutputFile = await f.provenance.prepareArtifact(
      "local",
      f.project.id,
      "invalid-output.txt",
      "text/plain",
      bytes("reserved"),
    );
    await assert.rejects(
      f.provenance.finish("local", f.project.id, damagedRun.id, {
        status: "completed",
        outputs: [{ output_type: "stream", name: "stdout", text: "\0" }],
        artifacts: [invalidOutputFile],
      }),
      status(400),
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int AS n FROM file_reservations WHERE id=$1",
          [invalidOutputFile.blobId],
        )
      ).rows[0].n,
      0,
    );
    assert.ok(
      !(await readdir(join(f.storage.root, "blobs"))).includes(
        invalidOutputFile.blobId,
      ),
    );
    const invalidTurnFile = await f.provenance.prepareArtifact(
      "local",
      f.project.id,
      "missing-turn.txt",
      "text/plain",
      bytes("reserved"),
    );
    await assert.rejects(
      f.provenance.finishTurn("local", f.project.id, randomUUID(), {
        status: "failed",
        artifacts: [invalidTurnFile],
      }),
      status(404),
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int AS n FROM file_reservations WHERE id=$1",
          [invalidTurnFile.blobId],
        )
      ).rows[0].n,
      0,
    );
    assert.ok(
      !(await readdir(join(f.storage.root, "blobs"))).includes(
        invalidTurnFile.blobId,
      ),
    );
    const chatFingerprint = createHash("sha256")
      .update("owned chat origin")
      .digest("hex");
    const chatGrant = await f.operations.grant(
      "local",
      "chat",
      chatFingerprint,
    );
    const chatJob = await f.operations.admit(
      {
        actor: "local",
        requestId: randomUUID(),
        purpose: "chat",
        fingerprint: chatFingerprint,
        grantId: chatGrant,
      },
      f.project.id,
    );
    const turnId = await f.sessions.openTurn(
      "local",
      f.project.id,
      chatJob.id,
      "generate a fixture",
    );
    await f.operations.dispatch("local", chatJob.id);
    await f.operations.observeStarted("local", chatJob.id);
    const chatFile = await f.provenance.prepareArtifact(
      "local",
      f.project.id,
      "chat.txt",
      "text/plain",
      bytes("chat"),
    );
    await assert.doesNotReject(
      f.provenance.finishTurn("local", f.project.id, turnId, {
        status: "completed",
        artifacts: [chatFile],
      }),
    );
    const fromTurn = await f.provenance.artifact(
      "local",
      f.project.id,
      chatFile.id,
    );
    assert.equal(fromTurn.origin.kind, "turn");
    assert.equal(fromTurn.origin.turnId, turnId);
    assert.equal(fromTurn.origin.runId, null);
    assert.equal(fromTurn.origin.notebookId, null);
    assert.equal(fromTurn.origin.status, "completed");
    const orphan = await f.storage.create();
    await orphan.handle.writeFile(Buffer.from("orphan"));
    await orphan.handle.sync();
    await orphan.handle.close();
    await f.storage.publish(orphan.id);
    assert.equal((await f.files.list("local", f.project.id)).length, 4);
    const next = await f.intent();
    const rollbackRun = await f.provenance.capture("local", f.project.id, next);
    await f.operations.dispatch("local", next.jobId);
    await f.operations.observeStarted("local", next.jobId);
    const rollbackFile = await f.provenance.prepareArtifact(
      "local",
      f.project.id,
      "rollback.txt",
      "text/plain",
      bytes("rollback"),
    );
    let fail = true;
    f.operations.write = (action) =>
      write(async (client) => {
        const result = await action(client);
        if (fail) {
          fail = false;
          throw new Error("owned synthetic failure before metadata COMMIT");
        }
        return result;
      });
    try {
      await assert.rejects(
        f.provenance.finish("local", f.project.id, rollbackRun.id, {
          status: "completed",
          outputs: [],
          artifacts: [rollbackFile],
        }),
        /before metadata COMMIT/,
      );
    } finally {
      f.operations.write = write;
    }
    assert.equal(
      (await f.operations.get("local", next.jobId)).state,
      "running",
    );
    assert.equal(
      (await f.provenance.get("local", f.project.id, rollbackRun.id)).outputs,
      null,
    );
    await assert.rejects(
      f.files.get("local", f.project.id, rollbackFile.id),
      status(404),
    );
    assert.ok(
      !(await readdir(join(f.storage.root, "blobs"))).includes(
        rollbackFile.blobId,
      ),
    );
    const fake = {
      ...rollbackFile,
      id: randomUUID(),
      blobId: orphan.id,
      size: 6,
      sha256: createHash("sha256").update("orphan").digest("hex"),
    };
    await assert.rejects(
      f.provenance.finish("local", f.project.id, rollbackRun.id, {
        status: "completed",
        outputs: [],
        artifacts: [fake],
      }),
      status(400),
    );
    assert.equal((await f.files.list("local", f.project.id)).length, 4);
    await f.operations.close();
    const recovered = new Operations(f.state, f.credentials);
    f.cleanup.push(() => recovered.close());
    await recovered.acquire();
    const restarted = new Provenance(
      recovered,
      f.files,
      f.state,
      f.credentials,
    );
    f.cleanup.push(() => restarted.close());
    assert.equal(
      (await restarted.get("local", f.project.id, rollbackRun.id)).status,
      "interrupted",
    );
    assert.equal(
      (await restarted.get("local", f.project.id, run.id)).status,
      "failed",
    );
    assert.deepEqual(
      await restarted.artifact("local", f.project.id, first.id),
      original,
    );
    const unrecorded = randomUUID(),
      legacyBlob = randomUUID();
    await writeFile(f.storage.path(legacyBlob), "legacy", { mode: 0o600 });
    await f.admin.query(
      "INSERT INTO file_versions(id,project_id,actor,name,mime,size,sha256,blob_id) VALUES($1,$2,'local','legacy','text/plain',6,$3,$4)",
      [
        unrecorded,
        f.project.id,
        createHash("sha256").update("legacy").digest("hex"),
        legacyBlob,
      ],
    );
    assert.equal(
      (await restarted.artifact("local", f.project.id, unrecorded)).origin.kind,
      "unavailable",
    );
  },
);
/** @id TEST-PROV-003 @verifies REQ-PROV-003 */
test(
  "TEST-PROV-003 retained stale outputs, unavailable capture and lost epoch without invented execution order",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t),
      input = await f.intent();
    let run: CapturedRun | undefined;
    await assert.doesNotReject(async () => {
      run = await f.provenance.capture("local", f.project.id, input);
      await f.operations.dispatch("local", input.jobId);
      await f.operations.observeStarted("local", input.jobId);
      run = await f.provenance.finish("local", f.project.id, run.id, {
        status: "completed",
        outputs: [
          { output_type: "stream", name: "stdout", text: "historical" },
        ],
        artifacts: [],
      });
    });
    assert.ok(run);
    const cell = {
      id: input.cellId,
      revision: input.revision,
      source: input.source,
      language: input.language,
      sharing: input.sharing,
      kernelEpoch: input.kernelEpoch,
    };
    const current = projectRun(run, cell);
    assert.equal(current.stale, false);
    assert.equal(current.lostState, false);
    assert.deepEqual(current.currentOutputs, run.outputs);
    const stale = projectRun(run, {
      ...cell,
      revision: 2,
      source: "new source",
    });
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.historicalOutputs, run.outputs);
    assert.deepEqual(stale.currentOutputs, []);
    assert.equal(projectRun(run, { ...cell, revision: 2 }).stale, true);
    assert.equal(
      projectRun(run, { ...cell, source: "new source" }).stale,
      true,
    );
    assert.equal(projectRun(run, { ...cell, sharing: [] }).stale, true);
    const lost = projectRun(run, { ...cell, kernelEpoch: randomUUID() });
    assert.equal(lost.lostState, true);
    assert.deepEqual(lost.historicalOutputs, run.outputs);
    assert.deepEqual(lost.currentOutputs, run.outputs);
    assert.equal("executionOrder" in lost, false);
    const unknown = await f.intent();
    unknown.environment = null;
    unknown.cellId = randomUUID();
    const missing = await f.provenance.capture("local", f.project.id, unknown);
    assert.equal(missing.environment, null);
    assert.equal(missing.outputs, null);
    const history = await f.provenance.history(
      "local",
      f.project.id,
      f.notebookId,
    );
    assert.deepEqual(
      history.map((r) => r.id),
      [missing.id, run.id],
    );
    await assert.rejects(
      f.provenance.get("local", f.project.id, randomUUID()),
      status(404),
    );
  },
);
