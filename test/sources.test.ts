import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { build } from "esbuild";
import { testDatabase } from "./helpers/database";
import { browserFixture } from "./helpers/browser";
import { ControlledCopilot } from "./helpers/copilot";
import { Operations } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { Files } from "../src/server/files";
import { FileStorage, storageDirectory } from "../src/server/file-storage";
import { Provenance } from "../src/server/provenance";
import { Notebooks, type NotebookRuntime } from "../src/server/notebooks";
import { Confirmations } from "../src/server/confirmations";
import { Proposals } from "../src/server/proposals";
import { Runtime } from "../src/server/runtime";
import { docker } from "../src/server/owned-containers";
import { Chat, type ChatPreview } from "../src/server/chat";
import { Copilot } from "../src/server/copilot";
import { Sources } from "../src/server/sources";
import { sourceRoutes } from "../src/server/source-routes";
import { ServiceError } from "../src/server/http";
import type { ExcerptSelection } from "../src/server/chat-context";
const status = (n: number) => (error: unknown) =>
  error instanceof ServiceError && error.status === n;
async function* bytes(text: string) {
  yield Buffer.from(text);
}
function submission(
  preview: ChatPreview,
  prompt: string,
  selections: ExcerptSelection[],
) {
  return {
    requestId: randomUUID(),
    prompt,
    selections,
    grantId: preview.grantId,
    fingerprint: preview.context.fingerprint,
  };
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
    if (failures.length)
      throw new AggregateError(failures, "SOURCE_FIXTURE_CLEANUP");
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
  const provenance = new Provenance(
    operations,
    files,
    db.state,
    db.credentials,
  );
  cleanup.push(() => provenance.close());
  let runtime: Runtime | undefined;
  const actual = () => {
    if (!runtime) throw new ServiceError(503, "RUNTIME_NOT_BOUND");
    return runtime;
  };
  const hooks: NotebookRuntime = {
    epoch: (actor, projectId, id) => actual().epoch(actor, projectId, id),
    invalidate: (actor, projectId, id, epoch) =>
      actual().invalidate(actor, projectId, id, epoch),
  };
  const notebooks = new Notebooks(
    operations,
    provenance,
    hooks,
    db.state,
    db.credentials,
  );
  cleanup.push(() => notebooks.close());
  const imageDigest = await docker([
    "image",
    "inspect",
    "aira-nexus-runtime:0.1",
    "--format",
    "{{.Id}}",
  ]);
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
  const sources = new Sources(files, provenance, confirmations);
  const sessions = new Sessions(
    operations,
    db.state,
    db.credentials,
    sources.resolver,
  );
  cleanup.push(() => sessions.close());
  const project = await sessions.createProject("local", "citation fixture");
  const other = await sessions.createProject(
    "local",
    "other owned citation fixture",
  );
  const foreign = await sessions.createProject(
    "other",
    "foreign citation fixture",
  );
  const notebook = await notebooks.create("local", project.id, {
    name: "Citation original",
    document: {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: "Cell-A",
          cell_type: "code",
          source: "print('ORIGINAL_CITED_OUTPUT')",
          metadata: { aira: { language: "python", sharing: [] } },
          outputs: [],
          execution_count: null,
        },
      ],
    },
  });
  const proposals = new Proposals(
    operations,
    notebooks,
    db.state,
    db.credentials,
  );
  cleanup.push(() => proposals.close());
  runtime = new Runtime(
    operations,
    files,
    provenance,
    db.state,
    db.credentials,
    imageDigest,
  );
  const engine = runtime;
  cleanup.push(async () => {
    await engine.close();
    runtime = undefined;
  });
  await engine.initialize(notebooks, confirmations);
  const sdk = new ControlledCopilot();
  const copilot = new Copilot({
    executable: process.execPath,
    state: db.state,
    runtimeFactory: sdk.factory,
  });
  const chat = new Chat({
    operations,
    sessions,
    files,
    provenance,
    proposals,
    confirmations,
    copilot,
  });
  async function run(
    inputs: { id: string; name: string; sha256: string }[] = [],
  ) {
    const current = await notebooks.get("local", project.id, notebook.id);
    const preview = await confirmations.prepareExecution("local", project.id, {
      notebookId: notebook.id,
      cellId: "Cell-A",
      revision: current.revision,
      inputs,
    });
    const result = await engine.execute("local", project.id, {
      requestId: randomUUID(),
      confirmationId: preview.id,
      fingerprint: preview.fingerprint,
    });
    assert.ok(result.run);
    assert.equal(result.run.status, "completed");
    return result.run;
  }
  return {
    ...db,
    operations,
    files,
    provenance,
    sources,
    sessions,
    project,
    other,
    foreign,
    notebook,
    notebooks,
    confirmations,
    runtime: engine,
    chat,
    sdk,
    run,
  };
}
/** @id TEST-CITE-001 @verifies REQ-CITE-001 */
test(
  "TEST-CITE-001 exact owned immutable versions and actual click-only source card; malformed400/foreign404",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const firstText = "SYNTHETIC_OLD_FILE_CONTENT";
    const name = '<svg onload="window.__sourceUnsafe=1">.txt';
    const first = await f.files.upload(
      "local",
      f.project.id,
      name,
      "text/plain",
      bytes(firstText),
    );
    const newer = await f.files.upload(
      "local",
      f.project.id,
      name,
      "text/plain",
      bytes("NEW_FILE_CONTENT"),
    );
    const alien = await f.files.upload(
      "other",
      f.foreign.id,
      "private.txt",
      "text/plain",
      bytes("FOREIGN_CONTENT"),
    );
    let record: Awaited<ReturnType<Sources["resolve"]>> | undefined;
    await assert.doesNotReject(async () => {
      record = await f.sources.resolve("local", f.project.id, "file", first.id);
    });
    assert.ok(record);
    assert.equal(record.kind, "file");
    assert.equal(record.token, `[file:${first.id}]`);
    assert.ok(record.kind === "file");
    assert.deepEqual(
      record.version,
      await f.provenance.artifact("local", f.project.id, first.id),
    );
    assert.equal(
      record.version.sha256,
      createHash("sha256").update(firstText).digest("hex"),
    );
    assert.notEqual(record.version.id, newer.id);
    assert.equal(record.version.origin.kind, "upload");
    for (const [kind, id, code] of [
      ["file", "not-a-uuid", 400],
      ["file", randomUUID(), 404],
      ["file", alien.id, 404],
      ["cell", "Cell-A", 400],
      ["run", first.id, 404],
    ] as const)
      await assert.rejects(
        f.sources.resolve("local", f.project.id, kind, id),
        status(code),
      );
    await assert.rejects(
      f.sources.resolve("local", f.other.id, "file", first.id),
      status(404),
    );
    await assert.rejects(
      f.sources.resolve("other", f.project.id, "file", first.id),
      status(404),
    );
    const missing = randomUUID();
    const cards = [
      { projectId: f.project.id, kind: "file", sourceId: first.id },
      { projectId: f.project.id, kind: "file", sourceId: missing },
      { projectId: f.project.id, kind: "cell", sourceId: "Cell-A" },
    ];
    const compiled = await build({
      stdin: {
        contents: `import React from "react";import{createRoot}from"react-dom/client";import{flushSync}from"react-dom";import{SourceReference}from"./src/components/source-reference";const cards=${JSON.stringify(cards)};createRoot(document.getElementById("root")).render(React.createElement(React.Fragment,null,...cards.map(props=>React.createElement(SourceReference,{...props,key:props.sourceId}))));const scoped=createRoot(document.getElementById("scope-root"));scoped.render(React.createElement(SourceReference,cards[0]));window.__moveCitation=projectId=>flushSync(()=>scoped.render(React.createElement(SourceReference,{...cards[0],projectId})));`,
        resolveDir: process.cwd(),
        loader: "js",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    assert.equal(compiled.outputFiles.length, 1);
    const router = sourceRoutes(f.sources),
      lookups: string[] = [];
    const browser = await browserFixture(async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/fixture.js")
        return new Response(compiled.outputFiles[0].text, {
          headers: { "Content-Type": "application/javascript" },
        });
      if (path.startsWith("/api/")) {
        lookups.push(path);
        return router(request);
      }
      return new Response(
        '<!doctype html><html><meta charset="utf-8"><div id="root"></div><div id="scope-root"></div><script src="/fixture.js"></script></html>',
        { headers: { "Content-Type": "text/html" } },
      );
    });
    t.after(() => browser.close());
    const context = await browser.browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const external: string[] = [];
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin === browser.origin)
        await route.continue();
      else {
        external.push(route.request().url());
        await route.fulfill({
          status: 418,
          body: "Blocked synthetic external request",
        });
      }
    });
    const page = await context.newPage();
    await page.goto(browser.origin);
    const owned = page.locator(`#root [data-citation-id="file:${first.id}"]`);
    await owned.getByRole("button", { name: "引用をコピー" }).waitFor();
    assert.equal(lookups.length, 0);
    assert.equal(f.sdk.calls.length, 0);
    await owned.getByRole("button", { name: "引用をコピー" }).click();
    await owned.getByText("コピーしました", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      `[file:${first.id}]`,
    );
    await owned.getByRole("button", { name: "参照を開く" }).click();
    await owned.locator("pre").waitFor();
    assert.ok(
      (await owned.locator("pre").textContent())?.includes(first.sha256),
    );
    assert.ok(
      !(await owned.locator("pre").textContent())?.includes(newer.sha256),
    );
    assert.equal(await owned.locator("svg").count(), 0);
    assert.equal(
      await page.evaluate(() => Reflect.get(window, "__sourceUnsafe")),
      undefined,
    );
    const unknown = page.locator(`[data-citation-id="file:${missing}"]`);
    await unknown.getByRole("button", { name: "引用をコピー" }).click();
    await unknown.getByRole("alert").waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      `[file:${first.id}]`,
    );
    const cell = page.locator('[data-citation-id="cell:Cell-A"]');
    await cell.getByRole("alert").waitFor();
    assert.equal(
      await cell.getByRole("button", { name: "参照を開く" }).isDisabled(),
      true,
    );
    assert.ok(lookups.every((path) => !path.includes("/cell/")));
    assert.deepEqual(external, []);
    assert.equal(f.sdk.calls.length, 0);
    const scoped = page.locator("#scope-root");
    await scoped.getByRole("button", { name: "参照を開く" }).click();
    await scoped.locator("pre").waitFor();
    const beforeSwitch = lookups.length;
    await page.evaluate((projectId) => {
      const move = Reflect.get(window, "__moveCitation");
      if (typeof move !== "function") throw new Error("Missing scope fixture");
      move(projectId);
    }, f.other.id);
    assert.equal(
      await scoped.locator("pre").count(),
      0,
      "A changed project must not retain the old source preview",
    );
    assert.equal(lookups.length, beforeSwitch, "Scope changes are not lookups");
    const response = await router(
      new Request(
        `${browser.origin}/api/projects/${f.project.id}/sources/file/${alien.id}`,
        { headers: { Host: new URL(browser.origin).host } },
      ),
    );
    assert.equal(response.status, 404);
    assert.ok(!(await response.text()).includes("FOREIGN_CONTENT"));
  },
);
/** @id TEST-CITE-002 @verifies REQ-CITE-002 */
test(
  "TEST-CITE-002 actual execution/edit/restart/new run retains original complete cited snapshot",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const input = await f.files.upload(
      "local",
      f.project.id,
      "input.csv",
      "text/csv",
      bytes("value\n17\n"),
    );
    const original = await f.run([
      { id: input.id, name: input.name, sha256: input.sha256 },
    ]);
    assert.match(JSON.stringify(original.outputs), /ORIGINAL_CITED_OUTPUT/);
    assert.ok(original.environment);
    let citation: Awaited<ReturnType<Sources["resolve"]>> | undefined;
    await assert.doesNotReject(async () => {
      citation = await f.sources.resolve(
        "local",
        f.project.id,
        "run",
        original.id,
      );
    });
    assert.ok(citation?.kind === "run");
    assert.deepEqual(citation.snapshot, original);
    assert.equal(
      citation.sourceSha256,
      createHash("sha256").update(original.source).digest("hex"),
    );
    const old = await f.notebooks.get("local", f.project.id, f.notebook.id);
    await f.notebooks.patch("local", f.project.id, old.id, {
      revision: old.revision,
      cellId: "Cell-A",
      source: "print('NEW_CURRENT_CELL_OUTPUT')",
    });
    const epoch = (await f.runtime.status("local", f.project.id, f.notebook.id))
      .kernelEpoch;
    assert.ok(epoch);
    await f.runtime.restart("local", f.project.id, f.notebook.id, epoch);
    assert.equal(
      (await f.runtime.status("local", f.project.id, f.notebook.id)).container,
      null,
    );
    const latest = await f.run();
    assert.notEqual(latest.id, original.id);
    assert.match(JSON.stringify(latest.outputs), /NEW_CURRENT_CELL_OUTPUT/);
    const reopened = await f.sources.resolve(
      "local",
      f.project.id,
      "run",
      original.id,
    );
    assert.ok(reopened.kind === "run");
    assert.deepEqual(reopened.snapshot, original);
    assert.notEqual(reopened.snapshot.revision, latest.revision);
    await assert.rejects(
      f.sources.resolve("local", f.project.id, "cell", "Cell-A"),
      status(400),
    );
    await assert.rejects(
      f.sources.resolve("local", f.other.id, "run", original.id),
      status(404),
    );
    reopened.snapshot.source = "CLIENT_MUTATION";
    const untouched = await f.sources.resolve(
      "local",
      f.project.id,
      "run",
      original.id,
    );
    assert.ok(untouched.kind === "run");
    assert.deepEqual(untouched.snapshot, original);
  },
);
/** @id TEST-CITE-003 @verifies REQ-CITE-003 */
test(
  "TEST-CITE-003 citation history stays inert; scoped scalar excerpts, exact32KiB UTF8 and stale/denied SDK controls",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const text = "😀".repeat(8192) + "x😀UNSELECTED_SUFFIX";
    const file = await f.files.upload(
      "local",
      f.project.id,
      "selected.txt",
      "text/plain",
      bytes(text),
    );
    const privateFile = await f.files.upload(
      "other",
      f.foreign.id,
      "private.txt",
      "text/plain",
      bytes("FOREIGN_PRIVATE"),
    );
    const run = await f.run();
    let reads = 0;
    const get = f.files.get.bind(f.files);
    f.files.get = async (...args) => {
      reads++;
      return get(...args);
    };
    const prompt = `Discuss literal citations [file:${file.id}] and [run:${run.id}] without opening them.`;
    const preview = await f.chat.preview("local", f.project.id, {
      prompt,
      selections: [],
    });
    assert.equal(reads, 0);
    assert.deepEqual(preview.context.excerpts, []);
    assert.equal(f.sdk.calls.length, 0);
    f.sdk.enqueue({});
    await f.chat.submit("local", f.project.id, submission(preview, prompt, []));
    assert.equal(reads, 0);
    assert.equal(f.sdk.calls.length, 1);
    assert.ok(!f.sdk.calls[0].input?.prompt.includes("UNSELECTED_SUFFIX"));
    assert.ok(!f.sdk.calls[0].input?.prompt.includes("ORIGINAL_CITED_OUTPUT"));
    const historyPreview = await f.chat.preview("local", f.project.id, {
      prompt: "Continue the literal citation discussion",
      selections: [],
    });
    assert.ok(historyPreview.context.wire.includes(file.id));
    assert.equal(reads, 0);
    assert.equal(f.sdk.calls.length, 1);
    const exact: ExcerptSelection = {
      kind: "file",
      sourceId: file.id,
      start: 0,
      end: 8192,
    };
    let exactPreview: ChatPreview | undefined;
    await assert.doesNotReject(async () => {
      exactPreview = await f.chat.preview("local", f.project.id, {
        prompt: "Send only the approved excerpt",
        selections: [exact],
      });
    });
    assert.ok(exactPreview);
    assert.equal(
      Buffer.byteLength(exactPreview.context.excerpts[0].text),
      32768,
    );
    assert.equal(exactPreview.context.excerpts[0].text, "😀".repeat(8192));
    assert.equal(f.sdk.calls.length, 1);
    await assert.rejects(
      f.chat.preview("local", f.project.id, {
        prompt: "Too many bytes",
        selections: [{ ...exact, end: 8193 }],
      }),
      status(413),
    );
    await assert.rejects(
      f.chat.preview("local", f.project.id, {
        prompt: "Foreign bytes",
        selections: [{ ...exact, sourceId: privateFile.id, end: 1 }],
      }),
      status(404),
    );
    await assert.rejects(
      f.chat.preview("local", f.other.id, {
        prompt: "Wrong owned project",
        selections: [{ ...exact, end: 1 }],
      }),
      status(404),
    );
    const denied = submission(exactPreview, "Send only the approved excerpt", [
      exact,
    ]);
    await assert.rejects(
      f.chat.submit("local", f.project.id, {
        ...denied,
        grantId: randomUUID(),
      }),
      status(409),
    );
    await assert.rejects(
      f.chat.submit("local", f.project.id, {
        ...denied,
        requestId: randomUUID(),
        selections: [{ ...exact, end: 1 }],
      }),
      status(409),
    );
    assert.equal(f.sdk.calls.length, 1);
    f.sdk.enqueue({});
    const reply = await f.chat.submit("local", f.project.id, denied);
    assert.equal(f.sdk.calls.length, 2);
    const wire = JSON.parse(f.sdk.calls[1].input!.prompt);
    assert.equal(wire.excerpts[0].text, "😀".repeat(8192));
    assert.ok(!f.sdk.calls[1].input?.prompt.includes("UNSELECTED_SUFFIX"));
    assert.deepEqual(await f.chat.submit("local", f.project.id, denied), reply);
    assert.equal(f.sdk.calls.length, 2);
    const resultSelection: ExcerptSelection = {
      kind: "result",
      sourceId: run.id,
      start: 0,
      end: "ORIGINAL_CITED_OUTPUT\n".length,
    };
    const resultPreview = await f.chat.preview("local", f.project.id, {
      prompt: "Explicit result excerpt",
      selections: [resultSelection],
    });
    assert.equal(
      resultPreview.context.excerpts[0].text,
      "ORIGINAL_CITED_OUTPUT\n",
    );
    assert.equal(f.sdk.calls.length, 2);
  },
);
