import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { PermissionRequest, Tool } from "@github/copilot-sdk";
import { testDatabase } from "./helpers/database";
import {
  assistant,
  bounded,
  ControlledCopilot,
  deferred,
  invoke,
  ManualChatDeadline,
  sdkEvent,
  type ControlledCall,
} from "./helpers/copilot";
import { connectDatabase } from "../src/server/database";
import { Operations } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { Projects } from "../src/server/projects";
import { Files, type FileVersion } from "../src/server/files";
import { FileStorage, storageDirectory } from "../src/server/file-storage";
import { Provenance } from "../src/server/provenance";
import { Notebooks } from "../src/server/notebooks";
import { Proposals } from "../src/server/proposals";
import { Confirmations } from "../src/server/confirmations";
import { Copilot, type CopilotTurn } from "../src/server/copilot";
import { Chat, type ChatPreview } from "../src/server/chat";
import { chatRoutes } from "../src/server/chat-routes";
import { copilotTools, type CopilotToolScope } from "../src/server/copilot-tools";
import {
  buildContext,
  type ExcerptSelection,
  type OwnedExcerpt,
} from "../src/server/chat-context";
import { previewFile } from "../src/server/file-preview";
import { fileRoutes } from "../src/server/file-routes";
import { ServiceError } from "../src/server/http";

const imageDigest = "sha256:" + "a".repeat(64);
const digest = (text: string | Buffer) =>
  createHash("sha256").update(text).digest("hex");
const status = (expected: number) => (error: unknown) =>
  error instanceof ServiceError && error.status === expected;
async function* bytes(text: string) {
  yield Buffer.from(text);
}
function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method,
    headers: {
      Host: "127.0.0.1:3000",
      Origin: "http://127.0.0.1:3000",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function submission(
  preview: ChatPreview,
  prompt: string,
  selections: ExcerptSelection[] = [],
  requestId = randomUUID(),
) {
  return {
    prompt,
    selections,
    requestId,
    grantId: preview.grantId,
    fingerprint: preview.context.fingerprint,
  };
}
async function noPath(path: string) {
  await assert.rejects(lstat(path), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ENOENT",
  );
}
async function cleaned(call: ControlledCall) {
  assert.ok(call.disposed, "the owned SDK process must be stopped");
  assert.ok(call.stops + call.forced > 0);
  assert.equal(call.listeners.size, 0, "SDK callbacks must be detached");
  if (call.config && !call.script.createError)
    assert.ok(call.deleted.includes(call.sessionId), "SDK session data removed");
  const cwd = call.config?.workingDirectory ?? call.options.workingDirectory;
  assert.ok(cwd);
  await noPath(cwd);
  assert.ok(call.options.baseDirectory);
  await noPath(call.options.baseDirectory);
}
async function fixture(t: TestContext) {
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
    if (failures.length) throw new AggregateError(failures, "CHAT_FIXTURE_CLEANUP");
  });
  const db = await testDatabase();
  cleanup.push(() => db.cleanup());
  const operations = new Operations(db.state, db.credentials);
  cleanup.push(() => operations.close());
  await operations.acquire();
  const storage = new FileStorage(await storageDirectory(db.state));
  await storage.initialize();
  const files = new Files(operations, storage, db.state, db.credentials);
  cleanup.push(() => files.close());
  const provenance = new Provenance(operations, files, db.state, db.credentials);
  cleanup.push(() => provenance.close());
  const sessions: Sessions = new Sessions(
    operations,
    db.state,
    db.credentials,
    async (selection): Promise<OwnedExcerpt> => {
      if (selection.kind !== "file")
        throw new ServiceError(404, "EXCERPT_NOT_FOUND");
      const file = await files.get("local", project.id, selection.sourceId);
      const preview = await previewFile(files, "local", project.id, file.id);
      if (preview.kind !== "text") throw new ServiceError(415, "TEXT_REQUIRED");
      const text = [...preview.text];
      if (selection.end > text.length)
        throw new ServiceError(400, "INVALID_EXCERPT_RANGE");
      return {
        ...selection,
        actor: "local",
        projectId: project.id,
        text: text.slice(selection.start, selection.end).join(""),
      };
    },
  );
  cleanup.push(() => sessions.close());
  const projects = new Projects(operations, sessions, db.state, db.credentials);
  cleanup.push(() => projects.close());
  const project = await sessions.createProject("local", "synthetic chat A");
  const other = await sessions.createProject("local", "synthetic chat B");
  const foreign = await sessions.createProject("foreign", "synthetic private");
  const notebooks = new Notebooks(
    operations,
    provenance,
    {
      async epoch() {
        return null;
      },
      async invalidate() {
        assert.fail("Chat tools must not execute or invalidate a kernel");
      },
    },
    db.state,
    db.credentials,
  );
  cleanup.push(() => notebooks.close());
  const notebook = await notebooks.create("local", project.id, {
    name: "Synthetic original",
    document: {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{
        id: "Cell-A",
        cell_type: "code",
        source: "x = 17",
        metadata: { aira: { language: "python", sharing: [] } },
        outputs: [],
        execution_count: null,
      }],
    },
  });
  const proposals = new Proposals(operations, notebooks, db.state, db.credentials);
  cleanup.push(() => proposals.close());
  const confirmations = new Confirmations(
    operations,
    notebooks,
    files,
    provenance,
    db.state,
    db.credentials,
    { imageDigest },
  );
  cleanup.push(() => confirmations.close());
  const admin = await connectDatabase(db.state, db.credentials, "migration");
  cleanup.push(() => admin.end());
  const sdk = new ControlledCopilot();
  const deadline = new ManualChatDeadline();
  const copilot = new Copilot({
    executable: process.execPath,
    state: db.state,
    runtimeFactory: sdk.factory,
  });
  const services = { operations, sessions, files, provenance, proposals, confirmations, copilot };
  const chat = new Chat(services, { deadline });
  async function prepare(prompt: string, projectId = project.id, selections: ExcerptSelection[] = []) {
    const preview = await chat.preview("local", projectId, { prompt, selections });
    return submission(preview, prompt, selections);
  }
  async function turnFor(requestId: string) {
    const result = await admin.query<{
      id: string;
      jobId: string;
      prompt: string;
      response: string;
      state: string;
    }>(
      `SELECT t.id,t.job_id AS "jobId",t.prompt,t.response,j.state
       FROM chat_turns t JOIN jobs j ON j.id=t.job_id
       WHERE j.request_id=$1 AND j.actor='local'`,
      [requestId],
    );
    assert.equal(result.rowCount, 1, "one durable turn for the request");
    return result.rows[0];
  }
  async function controlledTurn() {
    const fingerprint = digest(randomUUID());
    const grantId = await operations.grant("local", "chat", fingerprint);
    const job = await operations.admit({
      actor: "local", requestId: randomUUID(), purpose: "chat", fingerprint, grantId,
    }, project.id);
    const turnId = await sessions.openTurn("local", project.id, job.id, "synthetic tools");
    await operations.dispatch("local", job.id);
    await operations.observeStarted("local", job.id);
    const artifacts: FileVersion[] = [];
    const abort = new AbortController();
    const scope: CopilotToolScope = {
      actor: "local", projectId: project.id, turnId, files, proposals, confirmations,
      artifacts, excerpts: [], signal: abort.signal,
      onEvent: (event) => sessions.recordEvent("local", project.id, turnId, event),
    };
    return { job, turnId, artifacts, abort, scope };
  }
  return {
    ...db, operations, storage, files, provenance, sessions, projects, project,
    other, foreign, notebooks, notebook, proposals, confirmations, admin, sdk,
    deadline, copilot, services, chat, prepare, turnFor, controlledTurn,
  };
}

/** @id TEST-CHAT-001 @verifies REQ-CHAT-001 */
test("TEST-CHAT-001 durable owned bounded chat; idempotency, history and project serialization", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const prompt = "Synthetic question 🧪";
  let input!: Awaited<ReturnType<typeof f.prepare>>;
  await assert.doesNotReject(async () => {
    input = await f.prepare(prompt);
  }, "a valid owned prompt must produce a bounded context preview");
  f.sdk.enqueue({ run: async (call) => {
    const response = assistant("Synthetic answer, not the prompt.");
    call.emit(response);
    call.emit(sdkEvent("session.idle", {}));
    return response;
  } });
  const reply = await f.chat.submit("local", f.project.id, input);
  assert.equal(reply.state, "completed");
  assert.equal(reply.response, "Synthetic answer, not the prompt.");
  assert.deepEqual(await f.turnFor(input.requestId), {
    id: reply.id, jobId: reply.jobId, prompt, response: reply.response, state: "completed",
  });
  const reloaded = new Chat(f.services, { deadline: f.deadline });
  const opened = await reloaded.open("local", f.project.id);
  assert.equal(opened.project.chatId, f.project.chatId);
  assert.deepEqual(opened.history.turns, [{ id: reply.id, prompt, response: reply.response }]);
  assert.deepEqual((await reloaded.open("local", f.other.id)).history.turns, []);
  await assert.rejects(reloaded.open("local", f.foreign.id), status(404));
  await assert.rejects(reloaded.turn("local", f.other.id, reply.id), status(404));
  await assert.rejects(reloaded.turn("foreign", f.project.id, reply.id), status(404));
  assert.deepEqual(await reloaded.submit("local", f.project.id, input), reply);
  assert.equal(f.sdk.calls.length, 1, "durable retry must not call Copilot");
  for (const changed of [
    { ...input, prompt: "different" },
    { ...input, fingerprint: "b".repeat(64) },
    { ...input, selections: [{ kind: "file", sourceId: randomUUID(), start: 0, end: 1 }] },
  ]) await assert.rejects(reloaded.submit("local", f.project.id, changed), status(409));
  for (const invalid of ["", " \n\t ", "x".repeat(16001), "🧪".repeat(16001), "\ud800", "x\0"]) {
    await assert.rejects(f.chat.preview("local", f.project.id, { prompt: invalid }), status(400));
  }
  for (const valid of ["x".repeat(16000), "🧪".repeat(16000)]) {
    const preview = await f.chat.preview("local", f.project.id, { prompt: valid });
    assert.equal(JSON.parse(preview.context.wire).prompt, valid);
  }
  await assert.rejects(f.chat.preview("local", f.project.id, { prompt, chatId: randomUUID() }), status(400));
  await assert.rejects(f.chat.submit("local", f.other.id, input), status(409));
  await assert.rejects(f.chat.submit("local", f.project.id, { ...input, requestId: randomUUID() }), status(409));
  await cleaned(f.sdk.calls[0]);

  const held = deferred();
  const started = deferred();
  const pending = await f.prepare("Synthetic held turn");
  f.sdk.enqueue({ run: async (call) => {
    call.emit(sdkEvent("assistant.message_delta", { messageId: "held", deltaContent: "in progress" }));
    started.resolve();
    await held.promise;
    const response = assistant("in progress, then done");
    call.emit(response);
    call.emit(sdkEvent("session.idle", {}));
    return response;
  } });
  const active = f.chat.submit("local", f.project.id, pending);
  void active.catch(() => {});
  try {
    await bounded(started.promise, "held turn starts");
    const duplicate = f.chat.submit("local", f.project.id, pending);
    void duplicate.catch(() => {});
    const durable = await f.turnFor(pending.requestId);
    assert.equal(durable.state, "running");
    const partial = await f.chat.turn("local", f.project.id, durable.id);
    assert.notEqual(partial.state, "completed");
    await assert.rejects(f.projects.archive("local", f.project.id, 1), status(409));
    const second = await f.prepare("same-project concurrent attempt");
    await assert.rejects(f.chat.submit("local", f.project.id, second), status(409));
    const independent = await f.prepare("Synthetic B question", f.other.id);
    f.sdk.enqueue({});
    assert.equal((await f.chat.submit("local", f.other.id, independent)).state, "completed");
    held.resolve();
    assert.deepEqual(await bounded(duplicate, "duplicate joins original"), await bounded(active, "held response"));
  } finally {
    held.resolve();
    await active.catch(() => {});
  }
  assert.equal(f.sdk.calls.length, 3, "one call per actual accepted turn");
  for (const call of f.sdk.calls) await cleaned(call);
  await f.admin.query("UPDATE grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [input.grantId]);
  await f.projects.archive("local", f.project.id, 1);
  assert.deepEqual(await new Chat(f.services).submit("local", f.project.id, input), reply);
  await assert.rejects(f.chat.preview("local", f.project.id, { prompt: "new" }), status(409));
  const router = chatRoutes(f.chat);
  const history = await router(request(`/api/projects/${f.project.id}/chat`));
  assert.equal(history.status, 200);
  assert.equal(history.headers.get("Cache-Control"), "no-store");
  assert.equal((await history.json()).project.chatId, f.project.chatId);
  assert.equal((await router(request(`/api/projects/${f.project.id}/chat`, {}, "DELETE"))).status, 405);
  const hostile = request(`/api/projects/${f.project.id}/chat`);
  hostile.headers.set("Origin", "https://untrusted.invalid");
  assert.equal((await router(hostile)).status, 403);
});

/** @id TEST-CHAT-002 @verifies REQ-CHAT-002 */
test("TEST-CHAT-002 observed replies only; durable 502 failures,120s timeout and mandatory cleanup", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  let valid!: Awaited<ReturnType<typeof f.prepare>>;
  await assert.doesNotReject(async () => {
    valid = await f.prepare("Synthetic successful control");
    f.sdk.enqueue({});
    const reply = await f.chat.submit("local", f.project.id, valid);
    assert.equal(reply.response, "synthetic controlled reply");
  }, "controlled valid SDK reply must succeed before failure controls");
  await cleaned(f.sdk.calls[0]);
  const cases = [
    { label: "authentication", createError: new Error("AUTH synthetic-private-marker") },
    { label: "transport", run: async () => { throw new Error("TRANSPORT synthetic-private-marker"); } },
    { label: "no assistant", run: async (call: ControlledCall) => {
      call.emit(sdkEvent("session.idle", {}));
      return undefined;
    } },
    { label: "empty assistant", run: async () => assistant("") },
    { label: "error despite text", run: async (call: ControlledCall) => {
      call.emit(sdkEvent("assistant.message_delta", { messageId: "failed", deltaContent: "not complete" }));
      call.emit(sdkEvent("session.error", { errorType: "authentication", message: "synthetic-private-marker" }));
      call.emit(sdkEvent("session.idle", {}));
      return assistant("This text must not become a completed reply");
    } },
    { label: "aborted idle", run: async (call: ControlledCall) => {
      call.emit(sdkEvent("session.idle", { aborted: true }));
      return assistant("Not a successful terminal");
    } },
  ];
  const router = chatRoutes(f.chat);
  for (const control of cases) {
    const input = await f.prepare(`Synthetic ${control.label}`);
    f.sdk.enqueue(control);
    const response = await router(request(`/api/projects/${f.project.id}/chat/turns`, input));
    assert.equal(response.status, 502, control.label);
    assert.doesNotMatch(await response.text(), /synthetic-private-marker/);
    const turn = await f.turnFor(input.requestId);
    assert.equal(turn.state, "failed", control.label);
    assert.ok(!(await f.sessions.history("local", f.project.id)).turns.some((entry) => entry.id === turn.id));
    const stream = await f.chat.events("local", f.project.id, turn.id);
    const frames = await stream.text();
    assert.match(frames, /event: failed/);
    assert.doesNotMatch(frames, /"completed":true/);
    const calls = f.sdk.calls.length;
    assert.equal((await router(request(`/api/projects/${f.project.id}/chat/turns`, input))).status, 502);
    assert.equal(f.sdk.calls.length, calls, "failed retry cannot resend");
    await cleaned(f.sdk.calls.at(-1)!);
  }
  const input = await f.prepare("Synthetic deadline");
  const timeoutIndex = f.sdk.calls.length;
  const never = deferred<ReturnType<typeof assistant>>();
  f.sdk.enqueue({ run: async () => never.promise });
  const pending = f.chat.submit("local", f.project.id, input);
  void pending.catch(() => {});
  const call = await f.sdk.called(timeoutIndex);
  await bounded(call.started.promise, "timeout control starts");
  f.deadline.expire();
  await assert.rejects(bounded(pending, "business timeout"), status(502));
  assert.ok(call.aborts + call.forced > 0, "deadline aborts actual SDK work");
  assert.equal((await f.turnFor(input.requestId)).state, "timeout");
  assert.equal((await f.turnFor(input.requestId)).response, "");
  never.resolve(assistant("Late response after deadline"));
  await cleaned(call);

  const cleanupGate = deferred();
  const slowCleanup = await f.prepare("Synthetic cleanup completion barrier");
  f.sdk.enqueue({ onStop: async () => cleanupGate.promise });
  const cleanupIndex = f.sdk.calls.length;
  const completing = f.chat.submit("local", f.project.id, slowCleanup);
  void completing.catch(() => {});
  const stopping = await f.sdk.called(cleanupIndex);
  try {
    await bounded(stopping.stopping.promise, "cleanup barrier");
    assert.equal((await f.turnFor(slowCleanup.requestId)).state, "running");
  } finally {
    cleanupGate.resolve();
  }
  assert.equal((await bounded(completing, "cleanup finished")).state, "completed");
  await cleaned(stopping);
  const uncertain = await f.prepare("Synthetic unconfirmed cleanup");
  f.sdk.enqueue({
    stopErrors: [new Error("synthetic stop failed")],
    forceError: new Error("synthetic force stop failed"),
  });
  await assert.rejects(f.chat.submit("local", f.project.id, uncertain), status(502));
  const uncertainTurn = await f.turnFor(uncertain.requestId);
  assert.equal(uncertainTurn.state, "failed");
  assert.equal((await f.operations.get("local", uncertainTurn.jobId)).cleanup, "unknown");
});

/** @id TEST-CHAT-003 @verifies REQ-CHAT-003 */
test("TEST-CHAT-003 fresh isolated SDK sessions, deny-default permissions, exact excerpts and proposal-only tools", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const context = await buildContext("local", f.project.id, f.project.chatId,
    "Synthetic adapter isolation control",
    { turns: [], omittedComplete: 0, omittedIncomplete: 0 }, []);
  const argumentsForAdapter: CopilotTurn = {
    context, tools: [], signal: new AbortController().signal, onText: async () => {},
  };
  const directories: string[] = [];
  const forbidden: PermissionRequest[] = [
    { kind: "read", path: "/synthetic-private", intention: "fixture" },
    { kind: "shell", fullCommandText: "echo synthetic", intention: "fixture", commands: [],
      possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: false },
    { kind: "url", url: "https://synthetic.invalid", intention: "fixture" },
    { kind: "mcp", serverName: "ambient", toolName: "read", toolTitle: "fixture", readOnly: true },
    { kind: "custom-tool", toolName: "shell", toolDescription: "not registered" },
  ];
  f.sdk.enqueue({
    onCreate: async (call) => {
      const config = call.config!;
      assert.equal(call.options.mode, "empty");
      assert.equal(call.options.connection?.kind, "stdio");
      assert.ok(call.options.connection?.kind === "stdio");
      assert.equal(call.options.connection.path, process.execPath);
      assert.ok(isAbsolute(call.options.connection.path));
      assert.ok(config.workingDirectory);
      assert.equal(call.options.workingDirectory, config.workingDirectory);
      assert.notEqual(config.workingDirectory, process.cwd());
      assert.deepEqual(await readdir(config.workingDirectory), []);
      assert.equal((await lstat(config.workingDirectory)).mode & 0o777, 0o700);
      assert.equal(await (await lstat(config.workingDirectory)).isSymbolicLink(), false);
      assert.ok(call.options.baseDirectory);
      assert.notEqual(call.options.baseDirectory, config.workingDirectory);
      directories.push(config.workingDirectory);
      for (const key of ["enableConfigDiscovery", "enableOnDemandInstructionDiscovery",
        "enableFileHooks", "enableHostGitOperations", "enableSessionStore", "enableSkills"] as const) {
        assert.equal(config[key], false, `${key} must be explicitly disabled`);
      }
      assert.deepEqual(config.mcpServers, {});
      assert.deepEqual(config.skillDirectories, []);
      assert.deepEqual(config.pluginDirectories, []);
      assert.deepEqual(config.agentDirectories, []);
      assert.deepEqual(config.hookDirectories, []);
      assert.deepEqual(config.instructionDirectories, []);
      assert.deepEqual(config.availableTools, []);
      assert.ok(Array.isArray(config.excludedTools));
      assert.ok(config.excludedTools.includes("builtin:*"));
      assert.ok(config.excludedTools.includes("mcp:*"));
      assert.deepEqual(config.infiniteSessions, { enabled: false });
      assert.deepEqual(config.memory, { enabled: false });
      assert.equal(config.skipEmbeddingRetrieval, true);
      assert.equal(config.enableSessionTelemetry, false);
      assert.ok(config.onPermissionRequest);
      for (const permission of forbidden) {
        const decision = await config.onPermissionRequest(permission, { sessionId: call.sessionId });
        assert.equal(decision.kind, "reject", `${permission.kind} permission`);
      }
    },
  });
  await assert.doesNotReject(async () => {
    assert.equal(await f.copilot.reply(argumentsForAdapter), "synthetic controlled reply");
  }, "valid adapter control must reach only the injected SDK factory");
  await cleaned(f.sdk.calls[0]);
  f.sdk.enqueue({ onCreate: async (call) => {
    assert.ok(call.config?.workingDirectory);
    assert.notEqual(call.config.workingDirectory, directories[0]);
    assert.deepEqual(await readdir(call.config.workingDirectory), []);
  } });
  await f.copilot.reply(argumentsForAdapter);
  await cleaned(f.sdk.calls[1]);
  await assert.rejects(new Copilot({ executable: "copilot", state: f.state, runtimeFactory: f.sdk.factory }).reply(argumentsForAdapter));
  assert.equal(f.sdk.calls.length, 2, "relative executable rejected before dispatch");

  const selected = await f.files.upload("local", f.project.id, "selected.txt", "text/plain", bytes("hidden-prefix\napproved 🧪\nhidden-suffix"));
  const unselected = await f.files.upload("local", f.project.id, "unselected.txt", "text/plain", bytes("UNSELECTED_SYNTHETIC_SECRET"));
  const selections: ExcerptSelection[] = [{ kind: "file", sourceId: selected.id, start: 14, end: 24 }];
  const approved = await f.prepare("Synthetic excerpt question", f.project.id, selections);
  const wrong = { ...approved, selections: [{ ...selections[0], end: 25 }] };
  await assert.rejects(f.chat.submit("local", f.project.id, wrong), status(409));
  f.sdk.enqueue({ run: async (call) => {
    assert.ok(call.input?.prompt);
    const wire = JSON.parse(call.input.prompt);
    assert.deepEqual(wire.excerpts, [{ ...selections[0], text: "approved 🧪" }]);
    assert.doesNotMatch(call.input.prompt, /UNSELECTED_SYNTHETIC_SECRET|hidden-prefix|hidden-suffix/);
    const names = call.config!.tools!.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["propose_cell_change", "propose_execution", "propose_notebook", "read_excerpt", "save_file"]);
    assert.deepEqual(call.config!.availableTools, names.map((name) => `custom:${name}`));
    const excerpt = await call.invoke("read_excerpt", selections[0]);
    assert.equal(excerpt.resultType, "success");
    assert.match(excerpt.textResultForLlm, /approved 🧪/);
    for (const selection of [
      { ...selections[0], sourceId: unselected.id },
      { ...selections[0], start: 0 },
      { ...selections[0], end: 25 },
      { ...selections[0], projectId: f.foreign.id },
    ]) assert.notEqual((await call.invoke("read_excerpt", selection)).resultType, "success");
    const create = await call.invoke("propose_notebook", {
      name: "Synthetic proposed", cells: [{ id: "New-A", cell_type: "markdown", source: "# Proposed" }],
    });
    assert.equal(create.resultType, "success");
    const change = await call.invoke("propose_cell_change", {
      notebookId: f.notebook.id, revision: 1,
      cell: { id: "Cell-A", cell_type: "code", source: "x = 99", language: "python", sharing: [] },
    });
    assert.equal(change.resultType, "success");
    const execution = await call.invoke("propose_execution", {
      notebookId: f.notebook.id, cellId: "Cell-A", revision: 1, inputs: [],
    });
    assert.equal(execution.resultType, "success");
    assert.equal((await f.notebooks.list("local", f.project.id)).length, 1);
    assert.equal((await f.notebooks.get("local", f.project.id, f.notebook.id)).revision, 1);
    assert.equal((await f.notebooks.source("local", f.project.id, f.notebook.id, "Cell-A")).source, "x = 17");
    assert.equal((await f.proposals.list("local", f.project.id)).length, 2);
    assert.ok((await f.proposals.list("local", f.project.id)).every((proposal) => proposal.state === "pending"));
    assert.equal((await f.admin.query("SELECT count(*)::int AS n FROM jobs WHERE purpose='execution'")).rows[0].n, 0);
    assert.equal((await f.admin.query("SELECT count(*)::int AS n FROM runs")).rows[0].n, 0);
    return assistant("Synthetic proposal summary");
  } });
  assert.equal((await f.chat.submit("local", f.project.id, approved)).state, "completed");
  const denied = await f.prepare("Synthetic stale context", f.project.id, selections);
  await f.admin.query("UPDATE grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [denied.grantId]);
  await assert.rejects(f.chat.submit("local", f.project.id, denied), status(409));
  assert.equal(f.sdk.calls.length, 3, "unconsented/expired context sends no bytes");
  await cleaned(f.sdk.calls[2]);
});

/** @id TEST-CHAT-004 @verifies REQ-CHAT-004 */
test("TEST-CHAT-004 safe UTF8 1MiB save_file; immutable turn origin, safe preview/download and explicit refusal", { timeout: 180000 }, async (t) => {
  const f = await fixture(t);
  const turn = await f.controlledTurn();
  let tools!: Tool<unknown>[];
  let saved!: Awaited<ReturnType<typeof invoke>>;
  const text = "🧪".repeat(262144);
  await assert.doesNotReject(async () => {
    tools = copilotTools(turn.scope);
    saved = await invoke(tools, "save_file", { name: "研究.txt", text });
    assert.equal(saved.resultType, "success");
  }, "a safe basename and exactly1MiB UTF8 text must be accepted");
  assert.equal(turn.artifacts.length, 1);
  const first = turn.artifacts[0];
  assert.equal(first.size, 1048576);
  assert.equal(first.sha256, digest(text));
  assert.equal(first.projectId, f.project.id);
  assert.deepEqual(await f.files.list("local", f.project.id), [], "tool bytes are not public before terminal publication");
  assert.ok(saved.textResultForLlm.length < 65536, "tool reply contains a reference, not the full artifact");
  for (const name of ["../secret", "a/b", "a\\b", "..", "a.", "a ", "CON.txt", "x:y", "a\nb", "e\u0301.txt"]) {
    const refused = await invoke(tools, "save_file", { name, text: "synthetic" });
    assert.notEqual(refused.resultType, "success", name);
    assert.ok(refused.error || refused.textResultForLlm, "explicit tool error");
  }
  for (const input of [
    { name: "overflow.txt", text: text + "x" },
    { name: "overflow-emoji.txt", text: "🧪".repeat(262145) },
    { name: "invalid.txt", text: "\ud800" },
    { name: "not-text.txt", text: 17 },
    { name: "foreign.txt", text: "synthetic", projectId: f.foreign.id },
    { name: "external.txt", text: "synthetic", path: "/synthetic-private" },
  ]) assert.notEqual((await invoke(tools, "save_file", input)).resultType, "success");
  assert.equal(turn.artifacts.length, 1);
  assert.equal((await invoke(tools, "save_file", { name: "研究.txt", text: "second immutable version" })).resultType, "success");
  assert.equal((await invoke(tools, "save_file", { name: "empty.txt", text: "" })).resultType, "success");
  assert.equal(turn.artifacts.length, 3);
  assert.notEqual(turn.artifacts[1].id, first.id);
  await f.provenance.finishTurn("local", f.project.id, turn.turnId, { status: "completed", artifacts: turn.artifacts });
  const versions = await f.files.list("local", f.project.id);
  assert.equal(versions.length, 3);
  assert.equal((await f.files.get("local", f.project.id, first.id)).sha256, digest(text));
  const origin = await f.provenance.artifact("local", f.project.id, first.id);
  assert.deepEqual(origin.origin, {
    kind: "turn", chatId: f.project.chatId, notebookId: null, runId: null,
    turnId: turn.turnId, status: "completed",
  });
  const router = fileRoutes(f.files);
  const download = await router(request(`/api/projects/${f.project.id}/files/${first.id}/download`));
  assert.equal(download.status, 200);
  assert.match(download.headers.get("Content-Disposition")!, /^attachment;/);
  assert.equal(download.headers.get("Content-Type"), "application/octet-stream");
  assert.equal(digest(Buffer.from(await download.arrayBuffer())), digest(text));
  const preview = await router(request(`/api/projects/${f.project.id}/files/${first.id}/preview`));
  assert.equal(preview.status, 200);
  const displayed = await preview.json();
  assert.equal(displayed.kind, "text");
  assert.ok(displayed.omittedBytes > 0);
  assert.ok(text.startsWith(displayed.text));
  assert.equal((await router(request(`/api/projects/${f.other.id}/files/${first.id}/download`))).status, 404);
  const integrated = await f.prepare("Synthetic Chat artifact integration");
  let integratedId = "";
  f.sdk.enqueue({ run: async (call) => {
    const result = await call.invoke("save_file", {
      name: "integrated.txt", text: "synthetic integrated artifact",
    });
    assert.equal(result.resultType, "success");
    integratedId = JSON.parse(result.textResultForLlm).id;
    return assistant("Synthetic artifact ready");
  } });
  const integratedTurn = await f.chat.submit("local", f.project.id, integrated);
  assert.equal((await f.files.list("local", f.project.id)).length, 4,
    "Chat must publish the actual prepared SDK artifact on successful terminal");
  const integratedArtifact = await f.provenance.artifact("local", f.project.id, integratedId);
  assert.equal(integratedArtifact.origin.turnId, integratedTurn.id);
  assert.equal(integratedArtifact.origin.chatId, f.project.chatId);
  assert.equal(integratedArtifact.origin.status, "completed");
  assert.equal(integratedArtifact.sha256, digest("synthetic integrated artifact"));
  const failing = await f.prepare("Synthetic artifact then transport failure");
  f.sdk.enqueue({ run: async (call) => {
    assert.equal((await call.invoke("save_file", {
      name: "never-published.txt", text: "synthetic abandoned artifact",
    })).resultType, "success");
    throw new Error("SYNTHETIC_TRANSPORT_FAILURE_AFTER_TOOL");
  } });
  await assert.rejects(f.chat.submit("local", f.project.id, failing), status(502));
  assert.equal((await f.turnFor(failing.requestId)).state, "failed");
  assert.equal((await f.files.list("local", f.project.id)).length, 4,
    "a failed turn must discard unpublished prepared artifacts");
  for (const call of f.sdk.calls) await cleaned(call);
  const aborted = await f.controlledTurn();
  const abortedTools = copilotTools(aborted.scope);
  aborted.abort.abort();
  assert.notEqual((await invoke(abortedTools, "save_file", { name: "late.txt", text: "late" })).resultType, "success");
  assert.deepEqual(aborted.artifacts, []);
  await f.provenance.finishTurn("local", f.project.id, aborted.turnId, { status: "failed", artifacts: [] });
  assert.equal((await f.admin.query("SELECT count(*)::int AS n FROM file_reservations")).rows[0].n, 0);
  assert.deepEqual(await readdir(f.storage.root + "/pending"), []);
});
