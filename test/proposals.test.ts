import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { connectDatabase } from "../src/server/database";
import { Operations } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { Files } from "../src/server/files";
import { FileStorage, storageDirectory } from "../src/server/file-storage";
import { Provenance } from "../src/server/provenance";
import { Notebooks, type NotebookDocument } from "../src/server/notebooks";
import { Proposals, type Proposal } from "../src/server/proposals";
import {
  Confirmations,
  type Confirmation,
  type ConfirmedReceipt,
} from "../src/server/confirmations";
import { proposalRoutes } from "../src/server/proposal-routes";
import { ServiceError } from "../src/server/http";
const imageDigest = "sha256:" + "a".repeat(64);
const status = (n: number) => (e: unknown) =>
  e instanceof ServiceError && e.status === n;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function* bytes(text: string) {
  yield Buffer.from(text);
}
function document(): NotebookDocument {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: "Cell-A",
        cell_type: "code",
        source: "x = 17",
        metadata: {
          aira: {
            language: "python",
            sharing: [
              { name: "x", direction: "python-to-r", family: "scalar" },
            ],
          },
        },
        outputs: [],
        execution_count: null,
      },
      {
        id: "Note-A",
        cell_type: "markdown",
        source: "# Original",
        metadata: {},
      },
    ],
  };
}
async function fixture(t: TestContext) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
  });
  const db = await testDatabase();
  cleanup.push(() => db.cleanup());
  const operations = new Operations(db.state, db.credentials);
  cleanup.push(() => operations.close());
  await operations.acquire();
  const sessions = new Sessions(operations, db.state, db.credentials);
  cleanup.push(() => sessions.close());
  const project = await sessions.createProject("local", "proposal fixture");
  const foreign = await sessions.createProject(
    "other",
    "foreign proposal fixture",
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
  const notebooks = new Notebooks(
    operations,
    provenance,
    {
      async epoch() {
        return null;
      },
      async invalidate() {
        assert.fail(
          "proposal preparation must not invalidate or execute a kernel",
        );
      },
    },
    db.state,
    db.credentials,
  );
  cleanup.push(() => notebooks.close());
  const notebook = await notebooks.create("local", project.id, {
    name: "Original",
    document: document(),
  });
  const foreignNotebook = await notebooks.create("other", foreign.id, {
    name: "Foreign",
    document: document(),
  });
  const file = await files.upload(
    "local",
    project.id,
    "input.csv",
    "text/csv",
    bytes("sample,value\nA,17\n"),
  );
  const foreignFile = await files.upload(
    "other",
    foreign.id,
    "foreign.csv",
    "text/csv",
    bytes("private,value\nB,9\n"),
  );
  const clock = { value: Date.now() };
  const options = { imageDigest, now: () => clock.value };
  const confirmations = new Confirmations(
    operations,
    notebooks,
    files,
    provenance,
    db.state,
    db.credentials,
    options,
  );
  cleanup.push(() => confirmations.close());
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
  const execution = (revision = notebook.revision) => ({
    notebookId: notebook.id,
    cellId: "Cell-A",
    revision,
    inputs: [{ id: file.id, name: "input.csv", sha256: file.sha256 }],
  });
  const request = (confirmation: Confirmation, requestId = randomUUID()) => ({
    confirmationId: confirmation.id,
    requestId,
    fingerprint: confirmation.fingerprint,
  });
  async function run(text: string) {
    const source = await notebooks.source(
      "local",
      project.id,
      notebook.id,
      "Cell-A",
    );
    const fingerprint = hash(randomUUID());
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
      kernelEpoch: randomUUID(),
      environment: {
        imageDigest,
        python: "synthetic-producer",
        r: "synthetic-producer",
        packages: {},
      },
    });
    await operations.dispatch("local", job.id);
    await operations.observeStarted("local", job.id);
    return provenance.finish("local", project.id, captured.id, {
      status: "completed",
      outputs: [{ output_type: "stream", name: "stdout", text }],
      artifacts: [],
    });
  }
  return {
    ...db,
    operations,
    sessions,
    project,
    foreign,
    storage,
    files,
    provenance,
    notebooks,
    notebook,
    foreignNotebook,
    file,
    foreignFile,
    clock,
    options,
    confirmations,
    proposals,
    admin,
    application,
    execution,
    request,
    run,
  };
}
/** @id TEST-PROP-001 @verifies REQ-PROP-001 */
test(
  "TEST-PROP-001 typed pending/rejected proposals are inert; exact current acceptance is one revision",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const original = await f.notebooks.get(
      "local",
      f.project.id,
      f.notebook.id,
    );
    const change = {
      kind: "change-cell",
      notebookId: f.notebook.id,
      revision: 1,
      cell: {
        id: "Cell-A",
        cell_type: "code",
        source: "x = 23",
        language: "r",
        sharing: [{ name: "x", direction: "r-to-python", family: "scalar" }],
      },
    };
    let first: Proposal | undefined;
    await assert.doesNotReject(async () => {
      first = await f.proposals.propose("local", f.project.id, change);
    });
    assert.ok(first);
    const pending = first;
    assert.equal(pending.state, "pending");
    assert.equal(pending.receipt, null);
    change.cell.source = "unaccepted caller mutation";
    assert.equal(
      JSON.stringify(
        await f.notebooks.get("local", f.project.id, f.notebook.id),
      ),
      JSON.stringify(original),
    );
    assert.match(
      JSON.stringify(
        (await f.proposals.get("local", f.project.id, pending.id)).action,
      ),
      /x = 23/,
    );
    assert.doesNotMatch(
      JSON.stringify(
        (await f.proposals.get("local", f.project.id, pending.id)).action,
      ),
      /caller mutation/,
    );
    await assert.rejects(
      f.proposals.propose("local", f.project.id, {
        ...change,
        kind: "execute",
        source: "unsafe",
      }),
      status(400),
    );
    await assert.rejects(
      f.proposals.propose("local", f.project.id, {
        ...change,
        notebookId: f.foreignNotebook.id,
      }),
      status(404),
    );
    await assert.rejects(
      f.proposals.get("other", f.foreign.id, pending.id),
      status(404),
    );
    await assert.rejects(
      f.proposals.accept("local", f.project.id, pending.id, { revision: 0 }),
      status(409),
    );
    const edit = structuredClone(original.document);
    edit.cells[1].source = "# User edit";
    const edited = await f.notebooks.save(
      "local",
      f.project.id,
      f.notebook.id,
      { revision: 1, document: edit },
    );
    await assert.rejects(
      f.proposals.accept("local", f.project.id, pending.id, { revision: 1 }),
      status(409),
    );
    assert.equal(
      (await f.notebooks.get("local", f.project.id, f.notebook.id)).revision,
      2,
    );
    await assert.rejects(
      f.proposals.propose("local", f.project.id, { ...change, revision: 1 }),
      status(409),
    );
    const current = await f.proposals.propose("local", f.project.id, {
      ...change,
      notebookId: f.notebook.id.toUpperCase(),
      revision: 2,
      cell: { ...change.cell, source: "x = 23" },
    });
    assert.equal(current.action.kind, "change-cell");
    if (current.action.kind !== "change-cell")
      assert.fail("cell proposal required");
    assert.equal(current.action.notebookId, f.notebook.id);
    const accepted = await Promise.all([
      f.proposals.accept("local", f.project.id, current.id, { revision: 2 }),
      f.proposals.accept("local", f.project.id, current.id, { revision: 2 }),
    ]);
    assert.deepEqual(accepted[0], { notebookId: f.notebook.id, revision: 3 });
    assert.deepEqual(accepted[1], accepted[0]);
    const applied = await f.notebooks.get("local", f.project.id, f.notebook.id);
    assert.equal(applied.revision, 3);
    assert.equal(applied.document.cells[0].source, "x = 23");
    assert.deepEqual(applied.document.cells[0].metadata.aira, {
      language: "r",
      sharing: change.cell.sharing,
    });
    assert.deepEqual(applied.document.cells[1], edited.document.cells[1]);
    await assert.rejects(
      f.proposals.accept("local", f.project.id, current.id, { revision: 3 }),
      status(409),
    );
    const create = {
      kind: "create-notebook",
      name: "Proposed",
      cells: [
        {
          id: "new-r",
          cell_type: "code",
          source: "1L",
          language: "r",
          sharing: [],
        },
      ],
    };
    const denied = await f.proposals.propose("local", f.project.id, create);
    assert.equal((await f.notebooks.list("local", f.project.id)).length, 1);
    await f.proposals.reject("local", f.project.id, denied.id);
    await assert.rejects(
      f.proposals.accept("local", f.project.id, denied.id, { revision: 0 }),
      status(409),
    );
    assert.equal((await f.notebooks.list("local", f.project.id)).length, 1);
    const proposed = await f.proposals.propose("local", f.project.id, create);
    await assert.rejects(
      f.proposals.accept("local", f.project.id, proposed.id, { revision: 1 }),
      status(409),
    );
    const effect = await f.proposals.accept(
      "local",
      f.project.id,
      proposed.id,
      { revision: 0 },
    );
    assert.ok(effect);
    assert.deepEqual(
      await f.proposals.accept("local", f.project.id, proposed.id, {
        revision: 0,
      }),
      effect,
    );
    await assert.rejects(
      f.proposals.accept("local", f.project.id, proposed.id, { revision: 1 }),
      status(409),
    );
    await assert.rejects(
      f.proposals.reject("local", f.project.id, current.id),
      status(409),
    );
    assert.equal((await f.notebooks.list("local", f.project.id)).length, 2);
    assert.equal(
      (await f.notebooks.get("local", f.project.id, effect.notebookId)).document
        .cells[0].source,
      "1L",
    );
    const routes = proposalRoutes(f.proposals, f.confirmations);
    const url = `http://127.0.0.1:4141/api/projects/${f.project.id}/proposals`;
    const response = await routes(
      new Request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "127.0.0.1:4141",
          Origin: "http://127.0.0.1:4141",
        },
        body: JSON.stringify(create),
      }),
    );
    assert.equal(response.status, 201);
    assert.equal((await response.json()).state, "pending");
    assert.equal(
      (await routes(new Request(url, { headers: { Host: "127.0.0.1:4141" } })))
        .status,
      200,
    );
    assert.equal(
      (await routes(new Request(url, { headers: { Host: "foreign.invalid" } })))
        .status,
      403,
    );
    const archivedPending = await f.proposals.propose(
      "local",
      f.project.id,
      create,
    );
    const beforeArchive = await f.notebooks.list("local", f.project.id);
    await f.operations.write((client) =>
      client.query(
        "UPDATE projects SET status='archived',revision=revision+1 WHERE id=$1",
        [f.project.id],
      ),
    );
    await assert.rejects(
      f.proposals.propose("local", f.project.id, create),
      status(409),
    );
    await assert.rejects(
      f.proposals.accept("local", f.project.id, archivedPending.id, {
        revision: 0,
      }),
      status(409),
    );
    assert.deepEqual(
      await f.proposals.accept("local", f.project.id, proposed.id, {
        revision: 0,
      }),
      effect,
    );
    assert.deepEqual(
      await f.notebooks.list("local", f.project.id),
      beforeArchive,
    );
  },
);
/** @id TEST-PROP-002 @verifies REQ-PROP-002 */
test(
  "TEST-PROP-002 server-sealed five-minute execution source/sharing/inputs/epoch/image, deterministic expiry",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    let initial: Confirmation | undefined;
    const before = Date.now();
    await assert.doesNotReject(async () => {
      initial = await f.confirmations.prepareExecution(
        "local",
        f.project.id.toUpperCase(),
        { ...f.execution(), notebookId: f.notebook.id.toUpperCase() },
      );
    });
    assert.ok(initial);
    const prepared = initial;
    assert.equal(prepared.kind, "execution");
    assert.equal(prepared.snapshot.kind, "execution");
    assert.ok(
      Date.parse(prepared.expiresAt) - before >= 299000 &&
        Date.parse(prepared.expiresAt) - before <= 301000,
    );
    if (prepared.snapshot.kind !== "execution")
      assert.fail("execution snapshot required");
    assert.deepEqual(prepared.snapshot, {
      kind: "execution",
      actor: "local",
      projectId: f.project.id,
      chatId: f.project.chatId,
      notebookId: f.notebook.id,
      cellId: "Cell-A",
      revision: 1,
      source: "x = 17",
      language: "python",
      sharing: [{ name: "x", direction: "python-to-r", family: "scalar" }],
      inputs: [
        {
          id: f.file.id,
          workspaceName: "input.csv",
          size: f.file.size,
          sha256: f.file.sha256,
        },
      ],
      kernelEpoch: prepared.snapshot.kernelEpoch,
      imageDigest,
    });
    assert.match(prepared.snapshot.kernelEpoch, /^[a-f0-9-]{36}$/);
    assert.equal(
      (await f.admin.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n,
      0,
    );
    assert.equal(
      (await f.admin.query("SELECT count(*)::int AS n FROM runs")).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT state FROM runtime_reservations WHERE notebook_id=$1",
          [f.notebook.id],
        )
      ).rows[0].state,
      "reserved",
    );
    await assert.rejects(
      f.confirmations.prepareExecution("local", f.project.id, {
        ...f.execution(),
        source: "untrusted",
        actor: "other",
        kernelEpoch: randomUUID(),
      }),
      status(400),
    );
    await assert.rejects(
      f.confirmations.prepareExecution("local", f.project.id, {
        ...f.execution(),
        revision: 2,
      }),
      status(409),
    );
    await assert.rejects(
      f.confirmations.prepareExecution("local", f.project.id, {
        ...f.execution(),
        inputs: [{ id: f.file.id, name: "input.csv", sha256: "b".repeat(64) }],
      }),
      status(409),
    );
    await assert.rejects(
      f.confirmations.prepareExecution("local", f.project.id, {
        ...f.execution(),
        inputs: [
          {
            id: f.foreignFile.id,
            name: "foreign.csv",
            sha256: f.foreignFile.sha256,
          },
        ],
      }),
      status(404),
    );
    await assert.rejects(
      f.confirmations.prepareExecution("local", f.project.id, {
        ...f.execution(),
        notebookId: f.foreignNotebook.id,
      }),
      status(404),
    );
    await assert.rejects(
      f.confirmations.admit("local", f.project.id, "execution", {}),
      status(400),
    );
    await assert.rejects(
      f.confirmations.admit("local", f.project.id, "execution", {
        ...f.request(prepared),
        confirmationId: randomUUID(),
      }),
      status(409),
    );
    await assert.rejects(
      f.confirmations.admit(
        "other",
        f.foreign.id,
        "execution",
        f.request(prepared),
      ),
      status(404),
    );
    await assert.rejects(
      f.confirmations.get("other", f.foreign.id, prepared.id),
      status(404),
    );
    await f.notebooks.save("local", f.project.id, f.notebook.id, {
      revision: 1,
      document: f.notebook.document,
    });
    await assert.rejects(
      f.confirmations.admit(
        "local",
        f.project.id,
        "execution",
        f.request(prepared),
      ),
      status(409),
    );
    const current = await f.confirmations.prepareExecution(
      "local",
      f.project.id,
      f.execution(2),
    );
    const wrongGrant = await f.confirmations.prepareExecution(
      "local",
      f.project.id,
      f.execution(2),
    );
    const grantId = (
      await f.admin.query("SELECT grant_id FROM confirmations WHERE id=$1", [
        wrongGrant.id,
      ])
    ).rows[0].grant_id;
    try {
      await f.admin.query("UPDATE grants SET purpose='chat' WHERE id=$1", [
        grantId,
      ]);
      await assert.rejects(
        f.confirmations.admit(
          "local",
          f.project.id,
          "execution",
          f.request(wrongGrant),
        ),
        status(409),
      );
      await f.admin.query(
        "UPDATE grants SET purpose='execution',fingerprint=$2 WHERE id=$1",
        [grantId, "b".repeat(64)],
      );
      await assert.rejects(
        f.confirmations.admit(
          "local",
          f.project.id,
          "execution",
          f.request(wrongGrant),
        ),
        status(409),
      );
    } finally {
      await f.admin.query(
        "UPDATE grants SET purpose='execution',fingerprint=$2 WHERE id=$1",
        [grantId, wrongGrant.fingerprint],
      );
    }
    const databaseExpired = await f.confirmations.prepareExecution(
      "local",
      f.project.id,
      f.execution(2),
    );
    await f.admin.query(
      "UPDATE grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=(SELECT grant_id FROM confirmations WHERE id=$1)",
      [databaseExpired.id],
    );
    await assert.rejects(
      f.confirmations.admit(
        "local",
        f.project.id,
        "execution",
        f.request(databaseExpired),
      ),
      status(410),
    );
    const racingExpiry = await f.confirmations.prepareExecution(
      "local",
      f.project.id,
      f.execution(2),
    );
    const originalAdmit = f.operations.admitInTransaction.bind(f.operations);
    // Simulate expiry after the precheck on the actual locked grant and original admission query.
    f.operations.admitInTransaction = async (client, input, projectId) => {
      await client.query(
        "UPDATE grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [input.grantId],
      );
      return originalAdmit(client, input, projectId);
    };
    try {
      await assert.rejects(
        f.confirmations.admit(
          "local",
          f.project.id,
          "execution",
          f.request(racingExpiry),
        ),
        status(410),
      );
    } finally {
      f.operations.admitInTransaction = originalAdmit;
    }
    assert.equal(
      (await f.admin.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n,
      0,
    );
    await f.admin.query(
      "UPDATE runtime_reservations SET kernel_epoch=$2 WHERE notebook_id=$1",
      [f.notebook.id, randomUUID()],
    );
    await assert.rejects(
      f.confirmations.admit(
        "local",
        f.project.id,
        "execution",
        f.request(current),
      ),
      status(409),
    );
    const changedImage = await f.confirmations.prepareExecution(
      "local",
      f.project.id,
      f.execution(2),
    );
    const otherImage = new Confirmations(
      f.operations,
      f.notebooks,
      f.files,
      f.provenance,
      f.state,
      f.credentials,
      { ...f.options, imageDigest: "sha256:" + "b".repeat(64) },
    );
    try {
      await assert.rejects(
        otherImage.admit(
          "local",
          f.project.id,
          "execution",
          f.request(changedImage),
        ),
        status(409),
      );
    } finally {
      await otherImage.close();
    }
    const expires = await f.confirmations.prepareExecution(
      "local",
      f.project.id,
      f.execution(2),
    );
    f.clock.value = Date.parse(expires.expiresAt);
    await assert.rejects(
      f.confirmations.admit(
        "local",
        f.project.id,
        "execution",
        f.request(expires),
      ),
      status(410),
    );
    f.clock.value--;
    const admitted = await f.confirmations.admit(
      "local",
      f.project.id,
      "execution",
      f.request(expires),
    );
    assert.equal(admitted.admitted, true);
    assert.equal(
      (await f.operations.get("local", admitted.receipt.jobId)).state,
      "queued",
    );
    assert.equal(
      (await f.admin.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n,
      1,
    );
    assert.equal(
      (await f.admin.query("SELECT count(*)::int AS n FROM runs")).rows[0].n,
      0,
    );
  },
);
/** @id TEST-PROP-003 @verifies REQ-PROP-003 */
test(
  "TEST-PROP-003 exact UTF8 32KiB disclosure with owned run/file identities; no unconfirmed dispatch",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const text = " " + "漢".repeat(10922) + "\n";
    assert.equal(Buffer.byteLength(text), 32768);
    const run = await f.run(text);
    const selection = {
      kind: "run",
      id: run.id,
      start: 0,
      end: [...text].length,
    };
    let first: Confirmation | undefined;
    await assert.doesNotReject(async () => {
      first = await f.confirmations.prepareDisclosure("local", f.project.id, {
        selections: [selection],
      });
    });
    assert.ok(first);
    const preview = first;
    assert.equal(preview.snapshot.kind, "disclosure");
    if (preview.snapshot.kind !== "disclosure")
      assert.fail("disclosure snapshot required");
    assert.equal(preview.snapshot.text, text);
    assert.equal(preview.snapshot.sources[0].id, run.id);
    assert.equal(preview.snapshot.sources[0].sha256, hash(text));
    const submitted: Buffer[] = [];
    // Synthetic consumer proves the admission protocol; live SDK transport belongs to chat.
    const consume = (admission: {
      receipt: ConfirmedReceipt;
      admitted: boolean;
    }) => {
      if (!admission.admitted) return;
      assert.equal(admission.receipt.snapshot.kind, "disclosure");
      if (admission.receipt.snapshot.kind !== "disclosure")
        assert.fail("wrong dispatch purpose");
      submitted.push(Buffer.from(admission.receipt.snapshot.text, "utf8"));
    };
    assert.equal(submitted.length, 0);
    await assert.rejects(
      f.confirmations.admit(
        "other",
        f.foreign.id,
        "disclosure",
        f.request(preview),
      ),
      status(404),
    );
    await assert.rejects(
      f.confirmations.admit("local", f.project.id, "disclosure", {}),
      status(400),
    );
    await assert.rejects(
      f.confirmations.admit("local", f.project.id, "disclosure", {
        ...f.request(preview),
        fingerprint: hash(text + "edited"),
      }),
      status(409),
    );
    await assert.rejects(
      f.confirmations.admit("local", f.project.id, "disclosure", {
        ...f.request(preview),
        text: "edited",
      }),
      status(400),
    );
    await f.confirmations.deny("local", f.project.id, preview.id);
    await assert.rejects(
      f.confirmations.admit(
        "local",
        f.project.id,
        "disclosure",
        f.request(preview),
      ),
      status(409),
    );
    assert.equal(submitted.length, 0);
    const confirmed = await f.confirmations.prepareDisclosure(
      "local",
      f.project.id,
      { selections: [selection] },
    );
    const input = f.request(confirmed);
    consume(
      await f.confirmations.admit("local", f.project.id, "disclosure", input),
    );
    consume(
      await f.confirmations.admit("local", f.project.id, "disclosure", input),
    );
    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0], Buffer.from(text));
    const tooLarge = await f.run(text + "a");
    await assert.rejects(
      f.confirmations.prepareDisclosure("local", f.project.id, {
        selections: [{ ...selection, id: tooLarge.id, end: selection.end + 1 }],
      }),
      status(413),
    );
    const small = await f.run("Native result\n");
    const pair = await f.confirmations.prepareDisclosure(
      "local",
      f.project.id,
      {
        selections: [
          { kind: "run", id: small.id, start: 0, end: 14 },
          { kind: "file", id: f.file.id.toUpperCase(), start: 0, end: 12 },
        ],
      },
    );
    assert.equal(pair.snapshot.kind, "disclosure");
    if (pair.snapshot.kind !== "disclosure") assert.fail("disclosure required");
    assert.equal(pair.snapshot.text, "Native result\n\n\nsample,value");
    assert.equal(pair.snapshot.sources[1].id, f.file.id);
    assert.equal(pair.snapshot.sources[1].sha256, f.file.sha256);
    const pairAdmission = await f.confirmations.admit(
      "local",
      f.project.id,
      "disclosure",
      f.request(pair),
    );
    assert.equal(pairAdmission.admitted, true);
    assert.deepEqual(pairAdmission.receipt.snapshot, pair.snapshot);
    const changedSource = await f.confirmations.prepareDisclosure(
      "local",
      f.project.id,
      {
        selections: [{ kind: "run", id: small.id, start: 0, end: 14 }],
      },
    );
    // Fault injection into this fixture's immutable result authority, not a supported editing API.
    await f.admin.query(
      "UPDATE run_results SET outputs=$2::jsonb WHERE run_id=$1",
      [
        small.id,
        JSON.stringify([
          { output_type: "stream", name: "stdout", text: "Altered value\n" },
        ]),
      ],
    );
    try {
      await assert.rejects(
        f.confirmations.admit(
          "local",
          f.project.id,
          "disclosure",
          f.request(changedSource),
        ),
        status(409),
      );
    } finally {
      await f.admin.query(
        "UPDATE run_results SET outputs=$2::jsonb WHERE run_id=$1",
        [small.id, JSON.stringify(small.outputs)],
      );
    }
    const expires = await f.confirmations.prepareDisclosure(
      "local",
      f.project.id,
      { selections: [selection] },
    );
    f.clock.value = Date.parse(expires.expiresAt);
    await assert.rejects(
      f.confirmations.admit(
        "local",
        f.project.id,
        "disclosure",
        f.request(expires),
      ),
      status(410),
    );
    await assert.rejects(
      f.confirmations.prepareDisclosure("local", f.project.id, {
        selections: [{ kind: "file", id: f.foreignFile.id, start: 0, end: 1 }],
      }),
      status(404),
    );
    await assert.rejects(
      f.confirmations.prepareDisclosure("other", f.foreign.id, {
        selections: [selection],
      }),
      status(404),
    );
    await assert.rejects(
      f.confirmations.prepareDisclosure("local", f.project.id, {
        selections: [{ ...selection, text: "client authority" }],
      }),
      status(400),
    );
    preview.snapshot.text = "caller mutation";
    const stored = await f.confirmations.get("local", f.project.id, preview.id);
    assert.equal(stored.snapshot.kind, "disclosure");
    if (stored.snapshot.kind !== "disclosure")
      assert.fail("stored disclosure required");
    assert.equal(stored.snapshot.text, text);
  },
);
/** @id TEST-PROP-004 @verifies REQ-PROP-004 */
test(
  "TEST-PROP-004 atomic grant/job/receipt rollback; one concurrent winner and inert original retry before recapture",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    let initial: Confirmation | undefined;
    await assert.doesNotReject(async () => {
      initial = await f.confirmations.prepareExecution(
        "local",
        f.project.id,
        f.execution(),
      );
    });
    assert.ok(initial);
    const prepared = initial;
    const input = f.request(prepared);
    await f.admin
      .query(`CREATE FUNCTION refuse_test_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'controlled_receipt_failure'; END $$;
    CREATE TRIGGER refuse_test_receipt BEFORE INSERT ON confirmed_receipts FOR EACH ROW EXECUTE FUNCTION refuse_test_receipt()`);
    await assert.rejects(
      f.confirmations.admit("local", f.project.id, "execution", input),
      (e: unknown) =>
        e instanceof Error && e.message.includes("controlled_receipt_failure"),
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int AS n FROM jobs WHERE request_id=$1",
          [input.requestId],
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT g.consumed_by FROM grants g JOIN confirmations c ON c.grant_id=g.id WHERE c.id=$1",
          [prepared.id],
        )
      ).rows[0].consumed_by,
      null,
    );
    assert.equal(
      (await f.admin.query("SELECT count(*)::int AS n FROM confirmed_receipts"))
        .rows[0].n,
      0,
    );
    await f.admin.query(
      "DROP TRIGGER refuse_test_receipt ON confirmed_receipts; DROP FUNCTION refuse_test_receipt()",
    );
    const outcomes = await Promise.all([
      f.confirmations.admit("local", f.project.id, "execution", input),
      f.confirmations.admit("local", f.project.id, "execution", input),
    ]);
    assert.equal(outcomes.filter((r) => r.admitted).length, 1);
    assert.deepEqual(outcomes[0].receipt, outcomes[1].receipt);
    const receipt = outcomes[0].receipt;
    assert.equal(receipt.requestId, input.requestId);
    assert.equal(receipt.confirmationId, prepared.id);
    assert.equal(receipt.fingerprint, prepared.fingerprint);
    assert.deepEqual(receipt.snapshot, prepared.snapshot);
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int AS n FROM jobs WHERE request_id=$1",
          [input.requestId],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (await f.admin.query("SELECT count(*)::int AS n FROM confirmed_receipts"))
        .rows[0].n,
      1,
    );
    await assert.rejects(
      f.confirmations.admit(
        "local",
        f.project.id,
        "execution",
        f.request(prepared),
      ),
      status(409),
    );
    await assert.rejects(
      f.confirmations.admit("local", f.project.id, "disclosure", input),
      status(409),
    );
    const identical = await f.confirmations.prepareExecution(
      "local",
      f.project.id,
      f.execution(),
    );
    await assert.rejects(
      f.confirmations.admit("local", f.project.id, "execution", {
        ...input,
        confirmationId: identical.id,
      }),
      status(409),
    );
    const changed = structuredClone(f.notebook.document);
    changed.cells[0].source = "x = 99";
    await f.notebooks.save("local", f.project.id, f.notebook.id, {
      revision: 1,
      document: changed,
    });
    await f.operations.write((client) =>
      client.query(
        "UPDATE projects SET status='archived',revision=revision+1 WHERE id=$1",
        [f.project.id],
      ),
    );
    f.clock.value = Date.parse(prepared.expiresAt) + 1;
    let retried: Awaited<ReturnType<Confirmations["admit"]>> | undefined;
    await assert.doesNotReject(async () => {
      retried = await f.confirmations.admit(
        "local",
        f.project.id.toUpperCase(),
        "execution",
        {
          ...input,
          confirmationId: input.confirmationId.toUpperCase(),
          requestId: input.requestId.toUpperCase(),
        },
      );
    });
    assert.ok(retried);
    const replay = retried;
    assert.equal(replay.admitted, false);
    assert.deepEqual(replay.receipt, receipt);
    assert.equal(
      (await f.operations.get("local", receipt.jobId)).state,
      "queued",
    );
    await assert.rejects(
      f.confirmations.admit("local", f.project.id, "execution", {
        ...input,
        fingerprint: "b".repeat(64),
      }),
      status(409),
    );
    assert.equal(
      (await f.admin.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n,
      1,
    );
    assert.equal(
      (await f.admin.query("SELECT count(*)::int AS n FROM runs")).rows[0].n,
      0,
    );
    await assert.rejects(
      f.operations.admitInTransaction(
        f.application,
        {
          actor: "local",
          requestId: randomUUID(),
          purpose: "execution",
          fingerprint: hash("outside"),
          grantId: randomUUID(),
        },
        f.project.id,
      ),
      status(503),
    );
    await assert.rejects(
      f.operations.grantInTransaction(
        f.application,
        "local",
        "execution",
        hash("outside"),
        300000,
      ),
      status(503),
    );
  },
);
