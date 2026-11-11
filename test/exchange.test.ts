import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { testDatabase } from "./helpers/database";
import { externalNotebook } from "./helpers/jupyter";
import { Operations } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { Files } from "../src/server/files";
import { FileStorage, storageDirectory } from "../src/server/file-storage";
import { Provenance } from "../src/server/provenance";
import { Notebooks, type NotebookDocument } from "../src/server/notebooks";
import { Exchange } from "../src/server/exchange";
import { exchangeRoutes } from "../src/server/exchange-routes";
import { notebookRoutes } from "../src/server/notebook-routes";
import { docker, removeOwned, type ContainerIdentity } from "../src/server/owned-containers";
import { ServiceError } from "../src/server/http";
const status = (n: number) => (error: unknown) => error instanceof ServiceError && error.status === n;
const body = (value: unknown) => Buffer.from(JSON.stringify(value));
const wire = z.object({
  cells: z.array(z.object({ id: z.string(), cell_type: z.string(), source: z.string(), metadata: z.record(z.string(), z.json()), outputs: z.array(z.json()).optional(), execution_count: z.number().int().nullable().optional() }).passthrough()),
  metadata: z.record(z.string(), z.json()),
}).passthrough();
function document(): NotebookDocument {
  return { nbformat: 4, nbformat_minor: 5, metadata: { title: "Synthetic portable fixture" }, cells: [
    { id: "python", cell_type: "code", source: "print('inert source')", metadata: { aira: { language: "python", sharing: [] } }, outputs: [{ output_type: "stream", name: "stdout", text: "historical only\n" }], execution_count: 7 },
    { id: "raw", cell_type: "raw", source: "Raw attachment", metadata: {}, attachments: { "raw.txt": { "text/plain": "aGVsbG8=" } } },
    { id: "markdown", cell_type: "markdown", source: "![remote](https://foreign.invalid/never-load)", metadata: {}, attachments: { "plot.png": { "image/png": "aGVsbG8=" } } },
  ] };
}
async function fixture(t: TestContext) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const db = await testDatabase(); cleanup.push(() => db.cleanup());
  const operations = new Operations(db.state, db.credentials); cleanup.push(() => operations.close()); await operations.acquire();
  const sessions = new Sessions(operations, db.state, db.credentials); cleanup.push(() => sessions.close());
  const project = await sessions.createProject("local", "exchange fixture");
  const foreign = await sessions.createProject("other", "foreign exchange");
  const storage = new FileStorage(await storageDirectory(db.state)); await storage.initialize();
  const files = new Files(operations, storage, db.state, db.credentials); cleanup.push(() => files.close());
  const provenance = new Provenance(operations, files, db.state, db.credentials); cleanup.push(() => provenance.close());
  let runtimeCalls = 0;
  const notebooks = new Notebooks(operations, provenance, { async epoch() { runtimeCalls++; return null; }, async invalidate() { runtimeCalls++; } }, db.state, db.credentials);
  cleanup.push(() => notebooks.close());
  return { ...db, notebooks, project, foreign, exchange: new Exchange(notebooks), runtimeCalls: () => runtimeCalls };
}
/** @id TEST-XCH-001 @verifies REQ-XCH-001 */
test("TEST-XCH-001 strict inert import, language/magic, histories/attachments and exact body/display/source budgets", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  let decoded: NotebookDocument | undefined;
  await assert.doesNotReject(async () => { decoded = await f.exchange.decode(body(document())); });
  assert.ok(decoded);
  assert.deepEqual(decoded.cells.map(cell => [cell.id, cell.source]), document().cells.map(cell => [cell.id, cell.source]));
  const rawCell = decoded.cells[1], originalRaw = document().cells[1];
  assert.ok(rawCell.cell_type !== "code" && originalRaw.cell_type !== "code");
  assert.deepEqual(rawCell.attachments, originalRaw.attachments);
  const imported = await f.exchange.import("local", f.project.id, "Imported", body(document()));
  assert.deepEqual(await f.notebooks.history("local", f.project.id, imported.id), []);
  assert.deepEqual(imported.results, {}); assert.equal(f.runtimeCalls(), 0);
  assert.deepEqual(imported.document.cells[0].metadata.aira_imported, { kind: "imported", executed: false, native_run_id: null, external_execution_count: 7 });
  await assert.rejects(f.exchange.import("local", f.foreign.id, "Foreign", body(document())), status(404));
  await assert.rejects(f.exchange.decode(Buffer.from('{"nbformat":NaN}')), status(400));
  await assert.rejects(f.exchange.decode(Buffer.from([0xff])), status(400));
  await assert.rejects(f.exchange.decode(body({ ...document(), nbformat: 3 })), status(400));
  await assert.rejects(f.exchange.decode(body({ ...document(), metadata: { language_info: { name: "julia" } } })), status(400));
  await assert.rejects(f.exchange.decode(body({ ...document(), cells: [document().cells[0], document().cells[0]] })), status(400));
  await assert.rejects(f.exchange.decode(body({ ...document(), cells: Array.from({ length: 101 }, (_, i) => ({ ...document().cells[0], id: `c${i}` })) })), status(413));
  const absent = { ...document(), nbformat_minor: 4, cells: [{ cell_type: "code", source: ["print(", "'split')"], metadata: {}, outputs: [], execution_count: null }] };
  const assigned = await f.exchange.decode(body(absent)); assert.match(assigned.cells[0].id, /^[A-Za-z0-9_-]{1,64}$/); assert.equal(assigned.cells[0].source, "print('split')");
  const magic = await f.exchange.decode(body({ ...absent, cells: [{ ...absent.cells[0], source: "%%R -i x --output y\n y <- x + 1L" }] }));
  assert.deepEqual(magic.cells[0].metadata.aira, { language: "r", sharing: [{ name: "x", direction: "python-to-r" }, { name: "y", direction: "r-to-python" }] });
  await assert.rejects(f.exchange.decode(body({ ...absent, cells: [{ ...absent.cells[0], source: "%%R --unsafe shell\n1" }] })), status(400));
  const huge = { ...absent, metadata: { padding: "" } };
  huge.metadata.padding = "x".repeat(12 * 1024 ** 2 - body(huge).length);
  await assert.doesNotReject(() => f.exchange.decode(body(huge)));
  let exactImport: Awaited<ReturnType<Exchange["import"]>> | undefined;
  await assert.doesNotReject(async () => { exactImport = await f.exchange.import("local", f.project.id, "Exact body boundary", body(huge)); });
  assert.ok(exactImport); const exact = exactImport;
  await assert.doesNotReject(() => f.notebooks.save("local", f.project.id, exact.id, { revision: exact.revision, name: "Renamed large import", document: exact.document }));
  const renamed = await f.notebooks.get("local", f.project.id, exact.id);
  const edit = await notebookRoutes(f.notebooks)(new Request(`http://localhost/api/projects/${f.project.id}/notebooks/${exact.id}`, {
    method: "PATCH", headers: { Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ revision: renamed.revision, cellId: renamed.document.cells[0].id, source: "print('edited')" }),
  }));
  assert.equal(edit.status, 200);
  assert.equal((await f.notebooks.get("local", f.project.id, exact.id)).document.cells[0].source, "print('edited')");
  const original = await f.notebooks.imported("local", f.project.id, exact.id);
  assert.ok(original); assert.deepEqual(original.document, huge); assert.equal(original.executed, false); assert.equal(original.native_run_id, null);
  const forged = structuredClone(exact.document); delete forged.metadata.aira;
  await assert.rejects(f.notebooks.create("local", f.project.id, { name: "Forged import authority", document: forged }), status(413));
  await assert.rejects(f.notebooks.patch("local", f.project.id, exact.id, { revision: exact.revision, name: "Stale" }), status(409));
  await assert.rejects(f.notebooks.imported("local", f.foreign.id, exact.id), status(404));
  await assert.rejects(f.notebooks.patch("local", f.project.id, exact.id, { revision: renamed.revision + 1, source: "unpaired" }), status(400));
  huge.metadata.padding += "x"; await assert.rejects(f.exchange.decode(body(huge)), status(413));
  const display = { ...absent, cells: [{ ...absent.cells[0], outputs: [{ output_type: "stream", name: "stdout", text: "" }] }] };
  display.cells[0].outputs[0].text = "x".repeat(2 * 1024 ** 2 - Buffer.byteLength(JSON.stringify(display.cells[0].outputs)) - 2);
  await assert.doesNotReject(() => f.exchange.decode(body(display)));
  display.cells[0].outputs[0].text += "x"; await assert.rejects(f.exchange.decode(body(display)), status(413));
  const arrayDisplay = { ...absent, cells: [{ ...absent.cells[0], outputs: [{ output_type: "stream", name: "stdout", text: ["", ""] }] }] };
  arrayDisplay.cells[0].outputs[0].text[0] = "x".repeat(2 * 1024 ** 2 - Buffer.byteLength(JSON.stringify(arrayDisplay.cells[0].outputs)) - 2);
  await assert.doesNotReject(() => f.exchange.decode(body(arrayDisplay)));
  arrayDisplay.cells[0].outputs[0].text[0] += "x";
  await assert.rejects(f.exchange.decode(body(arrayDisplay)), status(413));
  await assert.rejects(f.exchange.decode(body({ ...absent, cells: [{ ...absent.cells[0], source: "x".repeat(65537) }] })), status(413));
  await assert.doesNotReject(() => f.exchange.decode(body({ ...absent, cells: [{ ...absent.cells[0], source: "x".repeat(65536) }] })));
  const route = exchangeRoutes(f.exchange);
  const endpoint = `http://localhost/api/projects/${f.project.id}/notebooks/import?name=HTTP-import`;
  assert.equal((await route(new Request(endpoint, { method: "POST", headers: { Host: "localhost", "Content-Type": "application/x-ipynb+json" }, body: body(document()) }))).status, 201);
  assert.equal((await route(new Request(endpoint, { method: "POST", headers: { Host: "foreign.invalid", "Content-Type": "application/x-ipynb+json" }, body: body(document()) }))).status, 403);
});
/** @id TEST-XCH-002 @verifies REQ-XCH-002 */
test("TEST-XCH-002 inspectable exact mixed export and actual standalone Jupyter nullable/float-bit roundtrip", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const containers: ContainerIdentity[] = [];
  t.after(async () => { for (const identity of containers) if (await docker(["ps", "-aq", "--no-trunc", "--filter", `id=${identity.id}`])) await removeOwned(identity); });
  const execute = (raw: Buffer) => externalNotebook(raw, f.credentials, identity => { containers.push(identity); });
  const gone = async (identity: ContainerIdentity) => assert.equal(await docker(["ps", "-aq", "--no-trunc", "--filter", `id=${identity.id}`]), "");
  const mixed: NotebookDocument = { ...document(), cells: [
    { id: "python", cell_type: "code", source: "import numpy as np\nimport pandas as pd\nnumbers = np.array([0.5, -0.0, np.nan], dtype=np.float32)\ntable = pd.DataFrame({'n': pd.Series([1, None], dtype='Int32'), 'text': pd.Series(['x', None], dtype='string')})", metadata: { aira: { language: "python", sharing: [{ name: "numbers", direction: "python-to-r", family: "array" }, { name: "table", direction: "python-to-r", family: "table" }] } }, outputs: [], execution_count: null },
    { id: "r", cell_type: "code", source: "numbers[1] <- 1; numbers[2] <- -0.0; table$n[1] <- 2L", metadata: { aira: { language: "r", sharing: [{ name: "numbers", direction: "r-to-python", family: "array" }, { name: "table", direction: "r-to-python", family: "table" }] } }, outputs: [], execution_count: null },
    { id: "verify", cell_type: "code", source: "assert numbers.dtype == np.dtype('float32')\nassert numbers.view('u4').tolist() == [1065353216, 2147483648, 2143289344]\nassert str(table.n.dtype) == 'Int32' and table.n[0] == 2 and pd.isna(table.n[1])\nassert str(table.text.dtype) == 'string' and pd.isna(table.text[1])\nprint('SYNTHETIC_EXTERNAL_JUPYTER_OK')", metadata: { aira: { language: "python", sharing: [] } }, outputs: [], execution_count: null },
    document().cells[1], document().cells[2],
  ] };
  let encoded: Buffer | undefined;
  await assert.doesNotReject(async () => { encoded = await f.exchange.encode(mixed); });
  assert.ok(encoded);
  const portable = wire.parse(JSON.parse(encoded.toString()));
  assert.match(portable.cells[0].source, /import numpy as np/);
  assert.match(portable.cells[0].source, /Dependencies:/);
  assert.match(portable.cells[2].source, /^_aira_execute\(/);
  const roundtrip = await f.exchange.decode(encoded);
  assert.deepEqual(roundtrip.cells.map(cell => [cell.id, cell.source, cell.metadata.aira]), mixed.cells.map(cell => [cell.id, cell.source, cell.metadata.aira]));
  const attached = roundtrip.cells[3], originalAttached = mixed.cells[3];
  assert.ok(attached.cell_type !== "code" && originalAttached.cell_type !== "code");
  assert.deepEqual(attached.attachments, originalAttached.attachments);
  const generated = wire.parse(JSON.parse(encoded.toString()));
  generated.cells[0].outputs = [{ output_type: "stream", name: "stdout", text: "preserved bootstrap history\n" }];
  generated.cells[0].execution_count = 11;
  const restoredGenerated = wire.parse(JSON.parse((await f.exchange.encode(await f.exchange.decode(body(generated)))).toString()));
  assert.deepEqual(restoredGenerated.cells[0].outputs, generated.cells[0].outputs);
  assert.equal(restoredGenerated.cells[0].id, generated.cells[0].id);
  assert.equal(restoredGenerated.cells[0].execution_count, 11);
  const standalone = await execute(encoded);
  assert.equal(standalone.failed, false);
  await gone(standalone.identity);
  const executed = wire.parse(JSON.parse(standalone.body.toString()));
  for (const cell of executed.cells.filter(cell => cell.cell_type === "code"))
    assert.ok(typeof cell.execution_count === "number" && cell.execution_count > 0, `Unexecuted cell ${cell.id}`);
  const verification = executed.cells.find(cell => cell.id === "verify"); assert.ok(verification);
  const text = (verification.outputs ?? []).flatMap(output => {
    const parsed = z.object({ output_type: z.literal("stream"), name: z.literal("stdout"), text: z.string() }).safeParse(output);
    return parsed.success ? [parsed.data.text] : [];
  }).join("");
  assert.equal(text.trim(), "SYNTHETIC_EXTERNAL_JUPYTER_OK");
  const historical = structuredClone(executed);
  historical.cells[0].outputs = [...(historical.cells[0].outputs ?? []), { output_type: "stream", name: "stdout", text: "SYNTHETIC_IMPORTED_INITIALIZATION_HISTORY\n" }];
  const external = await f.exchange.import("local", f.project.id, "External", body(historical));
  assert.deepEqual(await f.notebooks.history("local", f.project.id, external.id), []);
  assert.equal(f.runtimeCalls(), 0);
  for (const cell of external.document.cells.filter(cell => cell.cell_type === "code")) {
    const original = historical.cells.find(source => source.id === cell.id); assert.ok(original);
    assert.deepEqual(cell.metadata.aira_imported, { kind: "imported", executed: false, native_run_id: null, external_execution_count: original.execution_count });
  }
  const reexported = await f.exchange.export("local", f.project.id, external.id);
  const storedWire = wire.parse(JSON.parse(reexported.toString()));
  assert.deepEqual(storedWire.cells.map(cell => [cell.id, cell.outputs, cell.execution_count]), historical.cells.map(cell => [cell.id, cell.outputs, cell.execution_count]));
  const storedRoundtrip = await f.exchange.decode(reexported);
  assert.deepEqual(storedRoundtrip.cells.map(cell => cell.id), mixed.cells.map(cell => cell.id));
  assert.deepEqual(storedRoundtrip.cells.filter(cell => cell.cell_type !== "code"), roundtrip.cells.filter(cell => cell.cell_type !== "code"));
  const modified = wire.parse(JSON.parse(encoded.toString()));
  modified.cells[0].source += "\nprint('tampered')";
  await assert.rejects(f.exchange.decode(body(modified)), status(400));
  const mismatch = wire.parse(JSON.parse(encoded.toString()));
  mismatch.cells[2].source = mismatch.cells[2].source.replace("numbers[1]", "numbers[3]");
  await assert.rejects(f.exchange.decode(body(mismatch)), status(400));
  const rawR = { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python", language: "python" } }, cells: [{ id: randomUUID(), cell_type: "code", source: "values <- c(1L, 2L)", metadata: {}, outputs: [], execution_count: null }] };
  const negative = await execute(body(rawR)); assert.equal(negative.failed, true); await gone(negative.identity);
  const failedCell = wire.parse(JSON.parse(negative.body.toString())).cells[0];
  assert.ok(failedCell.outputs?.some(output => z.object({ output_type: z.literal("error"), ename: z.literal("SyntaxError") }).safeParse(output).success));
  const timeout = { ...rawR, cells: [{ ...rawR.cells[0], source: "import threading\nthreading.Event().wait()" }] };
  await assert.rejects(execute(body(timeout)), /EXTERNAL_JUPYTER_IOPUB_TIMEOUT/);
  const timed = containers.at(-1); assert.ok(timed); await gone(timed);
  const firstCode = mixed.cells[0]; assert.ok(firstCode.cell_type === "code");
  const oversized = document(); oversized.cells[0] = { ...firstCode, outputs: [{ output_type: "stream", name: "stdout", text: "x".repeat(2 * 1024 ** 2) }] };
  await assert.rejects(f.exchange.encode(oversized), status(413));
  const tooLarge = { ...mixed, cells: Array.from({ length: 100 }, (_, i) => ({ ...firstCode, id: `large-${i}`, source: "x".repeat(65536), outputs: [] })) };
  await assert.rejects(f.exchange.encode(tooLarge), status(413));
  assert.deepEqual(await f.notebooks.history("local", f.project.id, external.id), []);
});
