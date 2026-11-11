import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { testDatabase } from "./helpers/database";
import { Operations } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { Files, type FileVersion } from "../src/server/files";
import { FileStorage, storageDirectory } from "../src/server/file-storage";
import { Provenance } from "../src/server/provenance";
import { Notebooks, type NotebookRuntime } from "../src/server/notebooks";
import { Confirmations } from "../src/server/confirmations";
import { Runtime, type RuntimeOutcome } from "../src/server/runtime";
import { decodeChunk, verifyAck, RuntimeChannel } from "../src/server/transfers";
import { connectDatabase } from "../src/server/database";
import { docker, inspectOwned, stopOwned } from "../src/server/owned-containers";
import { ServiceError } from "../src/server/http";
import type { SharedVariable } from "../src/server/run-snapshots";
const status = (n: number) => (e: unknown) => e instanceof ServiceError && e.status === n;
async function* bytes(text: string) { yield Buffer.from(text); }
async function* zeroes(size: number) {
  const chunk = Buffer.alloc(512 * 1024);
  while (size) { const n = Math.min(size, chunk.length); yield chunk.subarray(0, n); size -= n; }
}
function stdout(outcome: RuntimeOutcome) {
  assert.ok(outcome.run); assert.ok(outcome.run.outputs);
  return outcome.run.outputs.flatMap(output => output.output_type === "stream" && output.name === "stdout" ? [output.text] : []).join("");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function deadline<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("TEST_DEADLINE_EXCEEDED")), ms); })]); }
  finally { clearTimeout(timer); }
}
async function failDockerInspectOnce(state: string, action: () => Promise<void>) {
  const realDocker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
  const shim = join(state, `docker-shim-${randomUUID()}`), marker = join(shim, "fail-once");
  await mkdir(shim, { mode: 0o700 });
  await writeFile(marker, "", { mode: 0o600 });
  await writeFile(join(shim, "docker"), `#!/bin/sh\nif [ "$1" = "inspect" ] && [ -f ${JSON.stringify(marker)} ]; then\n /bin/rm -f ${JSON.stringify(marker)}\n exit 1\nfi\nexec ${JSON.stringify(realDocker)} "$@"\n`, { mode: 0o700 });
  const path = process.env.PATH; assert.ok(path);
  try { process.env.PATH = `${shim}:${path}`; await action(); }
  finally { process.env.PATH = path; }
}
async function fixture(t: TestContext) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const db = await testDatabase(); cleanup.push(() => db.cleanup());
  const operations = new Operations(db.state, db.credentials); cleanup.push(() => operations.close()); await operations.acquire();
  const sessions = new Sessions(operations, db.state, db.credentials); cleanup.push(() => sessions.close());
  const project = await sessions.createProject("local", "runtime fixture");
  const foreign = await sessions.createProject("other", "foreign runtime fixture");
  const storage = new FileStorage(await storageDirectory(db.state)); await storage.initialize();
  const files = new Files(operations, storage, db.state, db.credentials); cleanup.push(() => files.close());
  const provenance = new Provenance(operations, files, db.state, db.credentials); cleanup.push(() => provenance.close());
  let runtime: Runtime | undefined;
  const actual = () => { if (!runtime) throw new ServiceError(503, "RUNTIME_NOT_BOUND"); return runtime; };
  const hooks: NotebookRuntime = {
    epoch: (actor, projectId, id) => actual().epoch(actor, projectId, id),
    invalidate: (actor, projectId, id, epoch) => actual().invalidate(actor, projectId, id, epoch),
  };
  const notebooks = new Notebooks(operations, provenance, hooks, db.state, db.credentials); cleanup.push(() => notebooks.close());
  const notebook = await notebooks.create("local", project.id, {
    name: "Runtime", document: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
      { id: "Cell-A", cell_type: "code", source: "print('initial')", metadata: { aira: { language: "python", sharing: [] } }, outputs: [], execution_count: null },
    ] },
  });
  const imageDigest = await docker(["image", "inspect", "aira-nexus-runtime:0.1", "--format", "{{.Id}}"]);
  const clock = { value: Date.now() };
  const confirmations = new Confirmations(operations, notebooks, files, provenance, db.state, db.credentials, { imageDigest, now: () => clock.value });
  cleanup.push(() => confirmations.close());
  runtime = new Runtime(operations, files, provenance, db.state, db.credentials, imageDigest, { now: () => clock.value });
  const engine = runtime; cleanup.push(async () => { await engine.close(); runtime = undefined; });
  await assert.doesNotReject(() => engine.initialize(notebooks, confirmations));
  async function cell(source: string, language: "python" | "r" = "python", sharing: SharedVariable[] = []) {
    const current = await notebooks.get("local", project.id, notebook.id);
    return notebooks.save("local", project.id, notebook.id, {
      revision: current.revision, document: { ...current.document, cells: [
        { id: "Cell-A", cell_type: "code", source, metadata: { aira: { language, sharing } }, outputs: [], execution_count: null },
      ] },
    });
  }
  async function prepare(inputs: { id: string; name: string; sha256: string }[] = []) {
    const source = await notebooks.source("local", project.id, notebook.id, "Cell-A");
    const preview = await confirmations.prepareExecution("local", project.id, { notebookId: notebook.id, cellId: "Cell-A", revision: source.revision, inputs });
    return { confirmationId: preview.id, requestId: randomUUID(), fingerprint: preview.fingerprint };
  }
  async function run(source: string, language: "python" | "r" = "python", sharing: SharedVariable[] = [], inputs: { id: string; name: string; sha256: string }[] = []) {
    await cell(source, language, sharing);
    return engine.execute("local", project.id, await prepare(inputs));
  }
  return { ...db, operations, sessions, project, foreign, files, provenance, notebooks, notebook, runtime: engine, confirmations, imageDigest, clock, cell, prepare, run };
}
/** @id TEST-RUN-001 @verifies REQ-RUN-001 */
test("TEST-RUN-001 real isolated stateful kernel; exact consent and serialized terminal publication/projection", { timeout: 120000 }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.runtime.status("local", f.project.id, f.notebook.id)).container, null);
  const expired = await f.prepare();
  f.clock.value = Date.parse((await f.confirmations.get("local", f.project.id, expired.confirmationId)).expiresAt) + 1;
  await assert.rejects(f.runtime.execute("local", f.project.id, expired), status(410));
  f.clock.value = Date.now();
  assert.equal((await f.runtime.status("local", f.project.id, f.notebook.id)).container, null);
  await assert.rejects(f.runtime.execute("local", f.project.id, {}), status(400));
  const unknown = await f.prepare();
  await assert.rejects(f.runtime.execute("local", f.project.id, { ...unknown, confirmationId: randomUUID() }), status(409));
  assert.equal((await f.runtime.status("local", f.project.id, f.notebook.id)).container, null);
  let result: RuntimeOutcome | undefined;
  await assert.doesNotReject(async () => { result = await f.run("import os, socket\nassert os.getuid() == 1000\ns = socket.socket(); s.settimeout(1)\ntry:\n s.connect(('1.1.1.1', 53))\nexcept OSError:\n print('NETWORK_BLOCKED')\nelse:\n raise AssertionError('external network available')\nfinally:\n s.close()\nvalue = 17\nprint('ISOLATED')"); });
  assert.ok(result);
  assert.equal(result.job.state, "completed"); assert.equal(result.job.started, "observed");
  assert.match(stdout(result), /NETWORK_BLOCKED[\s\S]*ISOLATED/);
  assert.ok(result.run?.environment); assert.equal(result.run.environment.imageDigest, f.imageDigest);
  assert.match(result.run.environment.python ?? "", /^3\.12\./); assert.match(result.run.environment.r ?? "", /^R version/);
  const state = await f.runtime.status("local", f.project.id, f.notebook.id); assert.ok(state.container);
  const inspected = await inspectOwned(state.container);
  assert.match(inspected.Config.User, /^1000(?::1000)?$/);
  assert.equal(inspected.HostConfig.NetworkMode, "none");
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.HostConfig.Memory, 2 * 1024 ** 3);
  assert.equal(inspected.HostConfig.NanoCpus, 1000000000);
  assert.equal(inspected.HostConfig.PidsLimit, 128);
  assert.deepEqual(inspected.HostConfig.CapDrop, ["ALL"]);
  assert.ok(inspected.HostConfig.SecurityOpt.some(value => value.startsWith("no-new-privileges")));
  assert.equal(inspected.Mounts.some(mount => mount.Type !== "tmpfs"), false);
  assert.match(inspected.HostConfig.Tmpfs["/tmp"], /noexec/);
  assert.match(inspected.HostConfig.Tmpfs["/workspace"], /noexec/);
  assert.match(stdout(await f.run("assert value == 17\nprint('STATE_PRESERVED')")), /STATE_PRESERVED/);
  const stale = await f.prepare(); await f.cell("print('new source')");
  await assert.rejects(f.runtime.execute("local", f.project.id, stale), status(409));
  assert.equal((await f.runtime.status("local", f.project.id, f.notebook.id)).container?.id, state.container.id);
  await f.cell("counter = globals().get('counter', 0) + 1\nprint(counter)");
  const firstInput = await f.prepare(), secondInput = await f.prepare();
  const terminal = deferred(), release = deferred();
  const finish = f.provenance.finish.bind(f.provenance);
  let first = true;
  f.provenance.finish = async (...args) => {
    const run = await finish(...args);
    if (first) { first = false; terminal.resolve(); await release.promise; }
    return run;
  };
  let one: Awaited<ReturnType<Runtime["submit"]>> | undefined;
  let two: Awaited<ReturnType<Runtime["submit"]>> | undefined;
  try {
    one = await f.runtime.submit("local", f.project.id, firstInput);
    await deadline(terminal.promise, 30000);
    assert.equal((await f.operations.get("local", one.receipt.jobId)).state, "completed");
    two = await f.runtime.submit("local", f.project.id, secondInput);
    const end = performance.now() + 500;
    do {
      assert.equal((await f.operations.get("local", two.receipt.jobId)).state, "queued");
      const current = await f.runtime.status("local", f.project.id, f.notebook.id);
      assert.equal(current.busy, true); assert.equal(current.activeJobId, one.receipt.jobId);
    } while (performance.now() < end);
    const queued = await f.runtime.submit("local", f.project.id, await f.prepare());
    const cancelled = await f.runtime.cancel("local", f.project.id, queued.receipt.jobId);
    assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.cleanup, "verified");
    assert.equal((await inspectOwned(state.container)).State.Running, true);
  } finally { release.resolve(); f.provenance.finish = finish; }
  assert.ok(one && two);
  const [a, b] = await Promise.all([f.runtime.wait("local", f.project.id, one.receipt.jobId), f.runtime.wait("local", f.project.id, two.receipt.jobId)]);
  assert.match(stdout(a), /^1\s*$/); assert.match(stdout(b), /^2\s*$/);
  assert.ok(b.run);
  assert.equal((await f.notebooks.get("local", f.project.id, f.notebook.id)).results["Cell-A"].runId, b.run.id);
  const replay = await f.runtime.submit("local", f.project.id, secondInput);
  assert.equal(replay.admitted, false); assert.deepEqual(replay.receipt, two.receipt);
  const secondBook = await f.notebooks.create("local", f.project.id, { name: "Second kernel", document: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: "B", cell_type: "code", source: "print('SECOND_KERNEL')", metadata: { aira: { language: "python", sharing: [] } }, outputs: [], execution_count: null }] } });
  const secondPreview = await f.confirmations.prepareExecution("local", f.project.id, { notebookId: secondBook.id, cellId: "B", revision: secondBook.revision, inputs: [] });
  assert.match(stdout(await f.runtime.execute("local", f.project.id, { confirmationId: secondPreview.id, requestId: randomUUID(), fingerprint: secondPreview.fingerprint })), /SECOND_KERNEL/);
  const thirdBook = await f.notebooks.create("local", f.project.id, { name: "Third kernel", document: { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: "C", cell_type: "code", source: "print('CAPACITY_BYPASS')", metadata: { aira: { language: "python", sharing: [] } }, outputs: [], execution_count: null }] } });
  const thirdPreview = await f.confirmations.prepareExecution("local", f.project.id, { notebookId: thirdBook.id, cellId: "C", revision: thirdBook.revision, inputs: [] });
  await assert.rejects(f.runtime.execute("local", f.project.id, { confirmationId: thirdPreview.id, requestId: randomUUID(), fingerprint: thirdPreview.fingerprint }), status(503));
  assert.equal((await f.runtime.status("local", f.project.id, thirdBook.id)).container, null);
  assert.equal((await inspectOwned(state.container)).State.Running, true);
  const complete = f.notebooks.completeRun;
  f.notebooks.completeRun = async (actor, projectId, notebookId, runId, input) => {
    await f.provenance.finish(actor, projectId, runId, input, notebookId);
    throw new ServiceError(503, "INJECTED_PROJECTION_FAILURE");
  };
  try {
    await f.cell("from pathlib import Path\nPath('outputs/not-a-file').mkdir()");
    const intent = await f.prepare();
    await assert.rejects(f.runtime.execute("local", f.project.id, intent), status(503));
    const retried = await f.runtime.submit("local", f.project.id, intent);
    assert.equal(retried.admitted, false);
    let outcome: RuntimeOutcome | undefined;
    await assert.doesNotReject(async () => { outcome = await f.runtime.wait("local", f.project.id, retried.receipt.jobId); });
    assert.ok(outcome); assert.equal(outcome.status, 503); assert.equal(outcome.job.state, "failed");
    assert.equal((await f.runtime.status("local", f.project.id, f.notebook.id)).container, null);
  } finally { f.notebooks.completeRun = complete; }
  const prepare = f.files.prepare, discard = f.files.discardPrepared;
  let temporary: FileVersion | undefined, preparedCount = 0;
  f.files.prepare = async function (...args) {
    if (++preparedCount === 2) throw new ServiceError(503, "INJECTED_PREPARE_FAILURE");
    const file = await prepare.apply(this, args); temporary = file; return file;
  };
  f.files.discardPrepared = async () => { throw new ServiceError(503, "INJECTED_DISCARD_FAILURE"); };
  try {
    await f.cell("from pathlib import Path\nPath('outputs/a.txt').write_text('a')\nPath('outputs/b.txt').write_text('b')");
    const intent = await f.prepare();
    await assert.rejects(f.runtime.execute("local", f.project.id, intent), status(503));
    const retried = await f.runtime.submit("local", f.project.id, intent);
    assert.equal(retried.admitted, false);
    const outcome = await f.runtime.wait("local", f.project.id, retried.receipt.jobId);
    assert.equal(outcome.status, 503); assert.equal(outcome.code, "RUNTIME_ARTIFACT_CLEANUP_UNCERTAIN");
    assert.equal(outcome.job.state, "failed"); assert.equal(outcome.job.cleanup, "unknown");
  } finally {
    f.files.prepare = prepare; f.files.discardPrepared = discard;
    if (temporary && f.files.isPrepared(temporary)) await discard.call(f.files, temporary);
  }
  assert.match(stdout(await f.run("print('CLOSE_FIXTURE_READY')")), /CLOSE_FIXTURE_READY/);
  const closeFirst = await f.runtime.status("local", f.project.id, f.notebook.id);
  const closeSecond = await f.runtime.status("local", f.project.id, secondBook.id);
  assert.ok(closeFirst.container && closeSecond.container);
  await failDockerInspectOnce(f.state, async () => {
    await assert.rejects(f.runtime.close(), error => error instanceof AggregateError);
  });
  for (const container of [closeFirst.container, closeSecond.container])
    assert.equal(await docker(["ps", "-aq", "--no-trunc", "--filter", `id=${container.id}`]), "");
});
/** @id TEST-RUN-002 @verifies REQ-RUN-002 */
test("TEST-RUN-002 actual Jupyter/rpy2 guarded scalar/shape/dtype/mask/precision and unchanged rejected destination", { timeout: 120000 }, async (t) => {
  const f = await fixture(t);
  const contract = await readFile("test/helpers/bridge-contract.py", "utf8");
  const outcome = await f.run(`exec(${JSON.stringify(contract)})\ncount = run_contract()\nassert count >= 60\nprint('BRIDGE_CONTRACT_OK')`);
  assert.equal(outcome.job.state, "completed"); assert.equal(stdout(outcome).trim(), "BRIDGE_CONTRACT_OK");
  await f.run("import numpy as np\nx = np.array([0.5, -0.0, np.nan], dtype=np.float32)", "python", [{ name: "x", direction: "python-to-r", family: "array" }]);
  const returned = await f.run("x[1] <- 1; x[2] <- -0.0", "r", [{ name: "x", direction: "r-to-python", family: "array" }]);
  assert.equal(returned.job.state, "completed");
  assert.match(stdout(await f.run("assert x.dtype == np.dtype('float32')\nassert x.shape == (3,)\nassert x.view('u4').tolist() == [1065353216, 2147483648, 2143289344]\nprint('BITS_PRESERVED')")), /BITS_PRESERVED/);
  const rejected = await f.run("x[1] <- 1/10", "r", [{ name: "x", direction: "r-to-python", family: "array" }]);
  assert.equal(rejected.job.state, "failed"); assert.ok(rejected.run?.outputs);
  assert.match(JSON.stringify(rejected.run.outputs), /FLOAT_PRECISION/);
  assert.match(stdout(await f.run("assert x[0] == 1 and x.dtype == np.dtype('float32')\nprint('DESTINATION_UNCHANGED')")), /DESTINATION_UNCHANGED/);
  assert.equal((await f.runtime.status("local", f.project.id, f.notebook.id)).state, "ready");
});
/** @id TEST-RUN-003 @verifies REQ-RUN-003 */
test("TEST-RUN-003 actual30s timeout/output/OOM/cancellation/restart exact stop and durable source", { timeout: 120000 }, async (t) => {
  const f = await fixture(t);
  await f.run("prior = 17\nprint('seed')");
  const previous = await f.runtime.status("local", f.project.id, f.notebook.id); assert.ok(previous.container);
  const started = performance.now();
  await assert.rejects(f.run("import threading\nthreading.Event().wait()"), status(504));
  assert.ok(performance.now() - started >= 29000 && performance.now() - started < 45000);
  assert.equal((await inspectOwned(previous.container)).State.Running, false);
  assert.equal(await f.runtime.epoch("local", f.project.id, f.notebook.id), null);
  assert.match((await f.notebooks.get("local", f.project.id, f.notebook.id)).document.cells[0].source, /Event/);
  const fresh = await f.run("assert 'prior' not in globals()\nprint('FRESH')"); assert.match(stdout(fresh), /FRESH/);
  const beforeOutput = await f.runtime.status("local", f.project.id, f.notebook.id); assert.ok(beforeOutput.container);
  await assert.rejects(f.run("print('x' * (2 * 1024 * 1024 + 1))"), status(413));
  assert.equal((await inspectOwned(beforeOutput.container)).State.Running, false);
  await f.run("print('before memory bound')");
  const beforeMemory = await f.runtime.status("local", f.project.id, f.notebook.id); assert.ok(beforeMemory.container);
  await assert.rejects(f.run("import numpy as np\nlarge = np.ones(3 * 1024**3 // 8, dtype=np.float64)"), status(503));
  assert.equal((await inspectOwned(beforeMemory.container)).State.Running, false);
  await f.cell("import threading\nthreading.Event().wait()");
  const pending = await f.runtime.submit("local", f.project.id, await f.prepare());
  const limit = performance.now() + 10000;
  while ((await f.operations.get("local", pending.receipt.jobId)).state !== "running") {
    assert.ok(performance.now() < limit, "dispatch deadline");
  }
  await f.operations.requestCancel("local", pending.receipt.jobId);
  await assert.rejects(f.operations.finish("local", pending.receipt.jobId, "cancelled"), status(409));
  const pendingEpoch = (await f.runtime.status("local", f.project.id, f.notebook.id)).kernelEpoch;
  assert.ok(pendingEpoch);
  const control = await connectDatabase(f.state, f.credentials, "application");
  try {
    await control.query("UPDATE runtime_containers SET state='stopped' WHERE kernel_epoch=$1", [pendingEpoch]);
    await assert.rejects(f.operations.finish("local", pending.receipt.jobId, "cancelled"), status(409));
  } finally {
    await control.query("UPDATE runtime_containers SET state='ready' WHERE kernel_epoch=$1", [pendingEpoch]);
    await control.end();
  }
  const cancelled = await f.runtime.cancel("local", f.project.id, pending.receipt.jobId);
  assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.cleanup, "verified");
  await f.run("saved = 23");
  const live = await f.runtime.status("local", f.project.id, f.notebook.id); assert.ok(live.container && live.kernelEpoch);
  const liveEpoch = live.kernelEpoch;
  await assert.rejects(f.runtime.restart("local", f.project.id, f.notebook.id, randomUUID()), status(409));
  assert.equal((await inspectOwned(live.container)).State.Running, true);
  try {
    await failDockerInspectOnce(f.state, async () => {
      await assert.rejects(f.runtime.restart("local", f.project.id, f.notebook.id, liveEpoch), status(503));
    });
    await assert.doesNotReject(() => f.runtime.restart("local", f.project.id, f.notebook.id, liveEpoch));
  } finally {
    await stopOwned(live.container);
    const restore = await connectDatabase(f.state, f.credentials, "application");
    try { await restore.query("UPDATE runtime_containers SET state='stopped' WHERE kernel_epoch=$1", [live.kernelEpoch]); }
    finally { await restore.end(); }
  }
  assert.equal((await inspectOwned(live.container)).State.Running, false);
  assert.match(stdout(await f.run("assert 'saved' not in globals()\nprint('RESTARTED')")), /RESTARTED/);
  const idle = await f.runtime.status("local", f.project.id, f.notebook.id); assert.ok(idle.container);
  f.clock.value = Date.now() + 600001;
  await f.runtime.expireIdle();
  assert.equal((await inspectOwned(idle.container)).State.Running, false);
});
/** @id TEST-RUN-004 @verifies REQ-RUN-004 */
test("TEST-RUN-004 actual selected CSV/256MiB stage+harvest; immutable hashes, ACK bounds and restart-required selection", { timeout: 120000 }, async (t) => {
  const f = await fixture(t);
  const transferId = randomUUID(), data = Buffer.alloc(512 * 1024, 17), sha256 = createHash("sha256").update(data).digest("hex");
  const frame = { transferId, offset: 0, data: data.toString("base64"), sha256 };
  assert.deepEqual(decodeChunk(frame, { transferId, offset: 0 }), data);
  verifyAck({ transferId, offset: data.length, sha256 }, { transferId, offset: data.length, sha256 });
  assert.throws(() => decodeChunk({ ...frame, offset: 1 }, { transferId, offset: 0 }), status(409));
  assert.throws(() => decodeChunk({ ...frame, sha256: "a".repeat(64) }, { transferId, offset: 0 }), status(409));
  assert.throws(() => decodeChunk({ ...frame, data: "not valid base64!" }, { transferId, offset: 0 }), status(400));
  assert.throws(() => decodeChunk({ ...frame, data: "AB==" }, { transferId, offset: 0 }), status(400));
  assert.throws(() => decodeChunk({ ...frame, data: Buffer.alloc(512 * 1024 + 1).toString("base64") }, { transferId, offset: 0 }), status(413));
  assert.throws(() => verifyAck({ transferId: randomUUID(), offset: data.length, sha256 }, { transferId, offset: data.length, sha256 }), status(409));
  const csv = await f.files.upload("local", f.project.id, "sample\u200b.csv", "text/csv", bytes("sample,value\nA,17\n"));
  const unselected = await f.files.upload("local", f.project.id, "unselected.txt", "text/plain", bytes("not selected"));
  const foreign = await f.files.upload("other", f.foreign.id, "private.txt", "text/plain", bytes("private"));
  const selected = [{ id: csv.id, name: csv.name, sha256: csv.sha256 }];
  const request = RuntimeChannel.prototype.request;
  let corrupted = false;
  RuntimeChannel.prototype.request = function (input, timeoutMs) {
    if (!corrupted && input.kind === "file-chunk") {
      corrupted = true;
      return request.call(this, { ...input, sha256: "f".repeat(64) }, timeoutMs).then(() => assert.fail("Worker ACKed corrupted bytes"));
    }
    return request.call(this, input, timeoutMs);
  };
  try { await assert.rejects(f.run("raise AssertionError('must not dispatch')", "python", [], selected), status(409)); }
  finally { RuntimeChannel.prototype.request = request; }
  assert.equal(corrupted, true);
  assert.equal(await f.runtime.epoch("local", f.project.id, f.notebook.id), null);
  const first = await f.run(`from pathlib import Path\nassert (Path('inputs') / ${JSON.stringify(csv.name)}).read_text() == 'sample,value\\nA,17\\n'\nassert not Path('inputs/unselected.txt').exists()\nprint('SELECTED_ONLY')`, "python", [], selected);
  assert.match(stdout(first), /SELECTED_ONLY/);
  const initial = await f.runtime.status("local", f.project.id, f.notebook.id); assert.ok(initial.container && initial.kernelEpoch);
  await assert.rejects(f.run("print('must not change inputs')", "python", [], [{ id: unselected.id, name: unselected.name, sha256: unselected.sha256 }]), status(409));
  assert.equal((await inspectOwned(initial.container)).State.Running, true);
  await assert.rejects(f.prepare([{ id: foreign.id, name: foreign.name, sha256: foreign.sha256 }]), status(404));
  await assert.rejects(f.prepare([{ id: csv.id, name: "../escape.csv", sha256: csv.sha256 }]), status(400));
  await f.runtime.restart("local", f.project.id, f.notebook.id, initial.kernelEpoch);
  const beforeTamper = await f.files.list("local", f.project.id);
  let finalTampered = false;
  RuntimeChannel.prototype.request = function (input, timeoutMs) {
    return request.call(this, input, timeoutMs).then(frame => {
      if (!finalTampered && input.kind === "harvest-end") { finalTampered = true; return { ...frame, sha256: "b".repeat(64) }; }
      return frame;
    });
  };
  try { await assert.rejects(f.run("from pathlib import Path\nPath('outputs/small.bin').write_bytes(b'abc')", "python", [], selected), status(503)); }
  finally { RuntimeChannel.prototype.request = request; }
  assert.equal(finalTampered, true);
  assert.deepEqual(await f.files.list("local", f.project.id), beforeTamper);
  assert.equal(await f.runtime.epoch("local", f.project.id, f.notebook.id), null);
  const inputs: FileVersion[] = [];
  for (const [index, size] of [100, 100, 56].entries()) {
    const file = await f.files.upload("local", f.project.id, `capacity-${index}.bin`, "application/octet-stream", zeroes(size * 1024 * 1024));
    inputs.push(file);
  }
  const manifests = inputs.map(file => ({ id: file.id, name: file.name, size: file.size, sha256: file.sha256 }));
  await assert.rejects(f.prepare([...inputs, csv].map(file => ({ id: file.id, name: file.name, sha256: file.sha256 }))), status(413));
  const code = `from pathlib import Path\nimport hashlib\nmanifest = ${JSON.stringify(manifests)}\nfor item in manifest:\n source = Path('inputs') / item['name']\n assert source.stat().st_size == item['size']\n digest = hashlib.sha256()\n with source.open('rb') as src, (Path('outputs') / item['name']).open('wb') as dst:\n  while True:\n   chunk = src.read(512 * 1024)\n   if not chunk: break\n   digest.update(chunk); dst.write(chunk)\n assert digest.hexdigest() == item['sha256']\nimport numpy as np\nnumeric = np.ones(256 * 1024**2 // 8, dtype=np.float64)\nnumeric[0] = -0.0\nprint('CAPACITY_256MiB_OK')`;
  const largeInputs = inputs.map(file => ({ id: file.id, name: file.name, sha256: file.sha256 }));
  const completed = await f.run(code, "python", [{ name: "numeric", direction: "python-to-r", family: "array" }], largeInputs);
  assert.match(stdout(completed), /CAPACITY_256MiB_OK/); assert.ok(completed.run);
  const projected = await f.notebooks.get("local", f.project.id, f.notebook.id);
  assert.equal(projected.results["Cell-A"].artifactIds.length, 3);
  for (const id of projected.results["Cell-A"].artifactIds) {
    const file = await f.provenance.artifact("local", f.project.id, id);
    const original = inputs.find(input => input.name === file.name); assert.ok(original);
    assert.equal(file.sha256, original.sha256); assert.equal(file.size, original.size);
    assert.equal(file.origin.runId, completed.run.id);
  }
  const returned = await f.run("numeric[2] <- 2", "r", [{ name: "numeric", direction: "r-to-python", family: "array" }], largeInputs);
  assert.equal(returned.job.state, "completed");
  assert.match(stdout(await f.run("assert numeric.shape == (256 * 1024**2 // 8,) and numeric.dtype == np.dtype('float64')\nassert np.signbit(numeric[0]) and numeric[1] == 2 and numeric[-1] == 1\nprint('LARGE_GUARD_BITS_OK')", "python", [], largeInputs)), /LARGE_GUARD_BITS_OK/);
});
