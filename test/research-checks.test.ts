import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./helpers/database";
import { Operations, type Terminal } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { Projects } from "../src/server/projects";
import { Files } from "../src/server/files";
import { FileStorage, storageDirectory } from "../src/server/file-storage";
import { Provenance } from "../src/server/provenance";
import { Notebooks } from "../src/server/notebooks";
import { Confirmations } from "../src/server/confirmations";
import { Sources } from "../src/server/sources";
import { Exchange } from "../src/server/exchange";
import {
  ResearchChecks,
  type CheckTarget,
  type CheckReport,
} from "../src/server/research-checks";
import { checkRoutes } from "../src/server/check-routes";
import { connectDatabase } from "../src/server/database";
import { ServiceError } from "../src/server/http";
import type { RunEnvironment, RunOutput } from "../src/server/run-snapshots";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const status = (n: number) => (error: unknown) =>
  error instanceof ServiceError && error.status === n;
async function* bytes(text: string) {
  yield Buffer.from(text);
}
function barrier() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("CHECK_TEST_DEADLINE")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
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
      throw new AggregateError(errors, "CHECK_FIXTURE_CLEANUP");
  });
  const db = await testDatabase();
  cleanup.push(() => db.cleanup());
  const operations = new Operations(db.state, db.credentials);
  cleanup.push(() => operations.close());
  await operations.acquire();
  const sessions = new Sessions(operations, db.state, db.credentials);
  cleanup.push(() => sessions.close());
  const projects = new Projects(operations, sessions, db.state, db.credentials);
  cleanup.push(() => projects.close());
  const project = await sessions.createProject(
    "local",
    "advisory checks fixture",
  );
  const other = await sessions.createProject(
    "local",
    "other owned checks fixture",
  );
  const foreign = await sessions.createProject(
    "foreign",
    "foreign checks fixture",
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
  const effects = { invalidations: 0 };
  const notebooks = new Notebooks(
    operations,
    provenance,
    {
      async epoch() {
        return null;
      },
      async invalidate() {
        effects.invalidations++;
        assert.fail("Advisory checks cannot invalidate a runtime");
      },
    },
    db.state,
    db.credentials,
  );
  cleanup.push(() => notebooks.close());
  const notebook = await notebooks.create("local", project.id, {
    name: "Check targets",
    document: {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: "Markdown-A",
          cell_type: "markdown",
          source: "AUROC=0.83",
          metadata: {},
        },
        {
          id: "Code-A",
          cell_type: "code",
          source: "print('not executed by these checker fixtures')",
          metadata: { aira: { language: "python", sharing: [] } },
          outputs: [],
          execution_count: null,
        },
      ],
    },
  });
  const confirmations = new Confirmations(
    operations,
    notebooks,
    files,
    provenance,
    db.state,
    db.credentials,
    { imageDigest: "sha256:" + "a".repeat(64) },
  );
  cleanup.push(() => confirmations.close());
  const sources = new Sources(files, provenance, confirmations);
  const services = { operations, sessions, files, notebooks, sources };
  const checks = new ResearchChecks(services, db.state, db.credentials);
  cleanup.push(() => checks.close());
  const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
  cleanup.push(() => admin.end());
  const application = await connectDatabase(
    db.state,
    db.credentials,
    "application",
  );
  cleanup.push(() => application.end());
  const syntheticEnvironment: RunEnvironment = {
    imageDigest: "sha256:" + "a".repeat(64),
    python: "synthetic Python fixture",
    r: "synthetic R fixture",
    packages: { "synthetic:package": "fixture-version" },
  };
  // These are server-record fixtures for classifier tests, not actual execution evidence.
  async function run(
    source: string,
    options: {
      state?: Terminal | "running";
      environment?: RunEnvironment | null;
      outputs?: RunOutput[];
      language?: "python" | "r";
    } = {},
  ) {
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
      jobId: job.id,
      notebookId: notebook.id,
      cellId: "Code-A",
      revision: 1,
      source,
      language: options.language ?? "python",
      sharing: [],
      inputs: [],
      kernelEpoch: randomUUID(),
      environment:
        options.environment === undefined
          ? syntheticEnvironment
          : options.environment,
    });
    await operations.dispatch("local", job.id);
    await operations.observeStarted("local", job.id);
    if (options.state === "running")
      return provenance.get("local", project.id, captured.id);
    return provenance.finish("local", project.id, captured.id, {
      status: options.state ?? "completed",
      outputs: options.outputs ?? [
        {
          output_type: "stream",
          name: "stdout",
          text: "synthetic observed output\n",
        },
      ],
      artifacts: [],
    });
  }
  async function target(text: string): Promise<CheckTarget> {
    const file = await files.upload(
      "local",
      project.id,
      `report-${randomUUID()}.md`,
      "text/markdown",
      bytes(text),
    );
    return { kind: "file", id: file.id, sha256: file.sha256 };
  }
  async function prepared(target: CheckTarget) {
    const preview = await checks.preview("local", project.id, { target });
    return {
      requestId: randomUUID(),
      target,
      fingerprint: preview.fingerprint,
    };
  }
  async function check(text: string) {
    return checks.run("local", project.id, await prepared(await target(text)));
  }
  return {
    ...db,
    operations,
    sessions,
    projects,
    project,
    other,
    foreign,
    files,
    provenance,
    notebooks,
    notebook,
    sources,
    services,
    checks,
    admin,
    application,
    effects,
    syntheticEnvironment,
    cleanup,
    run,
    target,
    prepared,
    check,
  };
}
/** @id TEST-CHECK-001 @verifies REQ-CHECK-001 */
test(
  "TEST-CHECK-001 canonical64KiB grammar/location/linkage with no-claim and explicit omitted scope",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const native = await f.run("np.random.seed(123)");
    const cases: [string, string, number][] = [
      [`AUROC = 0.83 [run:${native.id}]`, "passed", 1],
      ["p < 0.001", "warning", 1],
      [`AUROC=0.83 and F1=0.91 [run:${native.id}]`, "passed", 2],
      [`AUROC=0.83\n\n[run:${native.id}]`, "warning", 1],
      [
        "`AUROC = 0.83` DOI:10.1000/0.83 published in 2026 [Reference n=2026]",
        "not_checked",
        0,
      ],
      ["```\nAUROC = 0.83\np < 0.001\n```", "not_checked", 0],
      ["AUROC = 8.3e-1 and p < 1e-3", "not_checked", 0],
      [`accuracy=0.9 [run:${randomUUID()}]`, "warning", 1],
      ["n=123", "warning", 1],
      ["AUROC = 0.83.", "warning", 1],
      ["We saw p < 0.05.", "warning", 1],
      ["n=123.", "warning", 1],
      [`AUROC = 0.83. [run:${native.id}]`, "passed", 1],
      ["AUROC=0.83.7 n=123.5 F1=0.9%", "not_checked", 0],
    ];
    for (const [source, verdict, count] of cases) {
      let report: Awaited<ReturnType<ResearchChecks["run"]>> | undefined;
      await assert.doesNotReject(async () => {
        report = await f.check(source);
      });
      assert.ok(report);
      assert.equal(report.linkage.verdict, verdict, source);
      assert.equal(report.linkage.claims.length, count, source);
      assert.equal(report.sourceSha256, hash(source));
      assert.ok(report.scope.examined.length);
      assert.ok(report.scope.omitted.length);
    }
    const positioned = await f.check(
      `Introductory paragraph.\n\nAUROC=0.83 [run:${native.id}]`,
    );
    assert.equal(positioned.linkage.claims[0].line, 3);
    const repeatedAfterCode = await f.check(
      "`prefix\n AUROC=0.83\nsuffix` AUROC=0.83",
    );
    assert.equal(repeatedAfterCode.linkage.claims.length, 1);
    assert.equal(repeatedAfterCode.linkage.claims[0].line, 3);
    const laterLine = await f.check("n=14\n**AUROC=0.83**");
    assert.equal(laterLine.linkage.claims.length, 2);
    assert.equal(laterLine.linkage.claims[1].line, 2);
    const destinationOnly = await f.check(
      "[reference](https://example.test/?p=0.05)",
    );
    assert.equal(destinationOnly.linkage.claims.length, 0);
    assert.equal(destinationOnly.linkage.verdict, "not_checked");
    const table = await f.check(
      "| Metric | Value |\n| --- | --- |\n| AUROC | 0.83 |",
    );
    assert.equal(table.linkage.verdict, "not_checked");
    assert.ok(
      table.scope.omitted.some((value) => /table|unmapped/i.test(value)),
    );
    let resolutions = 0;
    const resolve = f.sources.resolve.bind(f.sources);
    f.sources.resolve = async (...args) => {
      resolutions++;
      return resolve(...args);
    };
    const manyReferences = await f.check(
      "n=123 " +
        Array.from({ length: 33 }, () => `[run:${randomUUID()}]`).join(" "),
    );
    assert.equal(resolutions, 32);
    assert.ok(
      manyReferences.scope.omitted.some((value) =>
        /run.reference.*limit/i.test(value),
      ),
    );
    assert.equal(manyReferences.linkage.verdict, "warning");
    assert.equal(
      (await f.check("x".repeat(65536))).linkage.verdict,
      "not_checked",
    );
    await assert.rejects(f.check("x".repeat(65537)), status(413));
    assert.equal(
      (await f.check("😀".repeat(16384))).linkage.verdict,
      "not_checked",
    );
    await assert.rejects(f.check("😀".repeat(16384) + "x"), status(413));
    await assert.rejects(
      f.prepared(await f.target("NUL\u0000REPORT")),
      status(400),
    );
    const invalidUtf8 = await f.files.upload(
      "local",
      f.project.id,
      "invalid-utf8.md",
      "text/markdown",
      (async function* () {
        yield Buffer.from([255]);
      })(),
    );
    await assert.rejects(
      f.prepared({
        kind: "file",
        id: invalidUtf8.id,
        sha256: invalidUtf8.sha256,
      }),
      status(400),
    );
  },
);
/** @id TEST-CHECK-002 @verifies REQ-CHECK-002 */
test(
  "TEST-CHECK-002 recorded completion/errors/environment versus warning stderr and absent imported evidence",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    for (const [options, verdict] of [
      [
        {
          outputs: [
            {
              output_type: "stream",
              name: "stderr",
              text: "Warning: synthetic advisory only",
            },
          ],
        },
        "passed",
      ],
      [
        {
          state: "failed",
          outputs: [
            {
              output_type: "error",
              ename: "SyntheticError",
              evalue: "fixture",
              traceback: [],
            },
          ],
        },
        "warning",
      ],
      [
        {
          outputs: [
            {
              output_type: "error",
              ename: "SyntheticError",
              evalue: "fixture",
              traceback: [],
            },
          ],
        },
        "warning",
      ],
      [{ environment: null }, "not_checked"],
      [
        { environment: { ...f.syntheticEnvironment, python: null } },
        "not_checked",
      ],
      [{ environment: { ...f.syntheticEnvironment, r: null } }, "not_checked"],
      [
        { environment: { ...f.syntheticEnvironment, packages: {} } },
        "not_checked",
      ],
      [
        {
          environment: {
            ...f.syntheticEnvironment,
            packages: { "synthetic:unavailable": null },
          },
        },
        "not_checked",
      ],
      [{ state: "running" }, "warning"],
    ] satisfies [Parameters<typeof f.run>[1], string][]) {
      const recorded = await f.run(
        "print('synthetic classifier input')",
        options,
      );
      let report: Awaited<ReturnType<ResearchChecks["run"]>> | undefined;
      await assert.doesNotReject(async () => {
        report = await f.check(`AUROC=0.83 [run:${recorded.id}]`);
      });
      assert.ok(report);
      assert.equal(report.execution.runs[0].verdict, verdict);
      assert.equal(report.execution.verdict, verdict);
      assert.deepEqual(
        report.execution.runs[0].environment,
        recorded.environment,
      );
    }
    const noNativeRun = randomUUID();
    const imported = await new Exchange(f.notebooks).import(
      "local",
      f.project.id,
      "Actual inert exchange import",
      Buffer.from(
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {},
          cells: [
            {
              id: noNativeRun,
              cell_type: "code",
              source: "np.random.seed(999)",
              metadata: {},
              outputs: [
                { output_type: "stream", name: "stdout", text: "AUROC=0.83" },
              ],
              execution_count: 7,
            },
          ],
        }),
      ),
    );
    assert.ok(imported.id);
    assert.equal(
      (await f.notebooks.imported("local", f.project.id, imported.id))
        ?.native_run_id,
      null,
    );
    const report = await f.check(
      `AUROC=0.83 [run:${noNativeRun}] [cell:${noNativeRun}]`,
    );
    assert.notEqual(report.execution.verdict, "passed");
    assert.equal(report.linkage.verdict, "warning");
    assert.ok(!report.seeds.declarations.some((item) => item.value === "999"));
  },
);
/** @id TEST-CHECK-003 @verifies REQ-CHECK-003 */
test(
  "TEST-CHECK-003 recognized immutable literal Python/R seed declarations never imply application/reproduction",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const cases: [string, string | null][] = [
      ["random.seed(11)", "11"],
      ["np.random.seed(22)", "22"],
      ["rng = np.random.default_rng(33)", "33"],
      ["set.seed(44)", "44"],
      ["# np.random.seed(55)", null],
      ["np.random.default_rng()", null],
      ["np.random.seed(variable)", null],
      ["print('not a seed')", null],
      ["numpy.random.seed(66)", null],
      ["np.random.seed(\n77\n)", null],
      ['text = """\nnp.random.seed(88)\n"""', null],
      ['text = "np.random.seed(99)"', null],
    ];
    for (const [source, expected] of cases) {
      const recorded = await f.run(source, {
        language: source.startsWith("set.seed") ? "r" : "python",
      });
      let report: Awaited<ReturnType<ResearchChecks["run"]>> | undefined;
      await assert.doesNotReject(async () => {
        report = await f.check(`[run:${recorded.id}]`);
      });
      assert.ok(report);
      assert.equal(
        report.seeds.verdict,
        expected ? "heuristic" : "not_checked",
      );
      assert.equal(report.seeds.declarations[0]?.value ?? null, expected);
      assert.equal(report.seeds.appliedOrReproduced, false);
    }
    const old = await f.run("np.random.seed(123)");
    const current = await f.notebooks.get("local", f.project.id, f.notebook.id);
    await f.notebooks.patch("local", f.project.id, f.notebook.id, {
      revision: current.revision,
      cellId: "Code-A",
      source: "np.random.seed(987)",
    });
    const report = await f.check(`[run:${old.id}]`);
    assert.ok(report.seeds.declarations.some((item) => item.value === "123"));
    assert.ok(!report.seeds.declarations.some((item) => item.value === "987"));
  },
);
/** @id TEST-CHECK-004 @verifies REQ-CHECK-004 */
test(
  "TEST-CHECK-004 authoritative target capture, immutable report/replay/version and archive/writer fences without other effects",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const chatFingerprint = hash("synthetic recorded chat snapshot");
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
      "Synthetic controlled chat record; no SDK call",
    );
    await f.operations.dispatch("local", chatJob.id);
    await f.operations.observeStarted("local", chatJob.id);
    await f.sessions.recordEvent("local", f.project.id, turnId, {
      kind: "partial",
      text: "n=12",
    });
    await f.operations.finish("local", chatJob.id, "completed");
    const chatTarget: CheckTarget = {
      kind: "chat",
      id: turnId,
      sha256: hash("n=12"),
    };
    let chatReport: Awaited<ReturnType<ResearchChecks["run"]>> | undefined;
    await assert.doesNotReject(async () => {
      chatReport = await f.checks.run(
        "local",
        f.project.id,
        await f.prepared(chatTarget),
      );
    });
    assert.ok(chatReport);
    assert.equal(chatReport.sourceSha256, hash("n=12"));
    assert.equal(chatReport.linkage.verdict, "warning");
    await assert.rejects(
      f.checks.preview("local", f.other.id, { target: chatTarget }),
      status(404),
    );
    const markdown: CheckTarget = {
      kind: "markdown",
      notebookId: f.notebook.id,
      cellId: "Markdown-A",
      revision: 1,
    };
    let request: Awaited<ReturnType<typeof f.prepared>> | undefined;
    await assert.doesNotReject(async () => {
      request = await f.prepared(markdown);
    });
    assert.ok(request);
    const jobsBefore = await f.admin.query<{ count: string }>(
      "SELECT count(*)::text FROM jobs WHERE purpose IN ('chat','execution')",
    );
    const grantsBefore = await f.admin.query<{ count: string }>(
      "SELECT count(*)::text FROM grants",
    );
    let original: Awaited<ReturnType<ResearchChecks["run"]>> | undefined;
    await assert.doesNotReject(async () => {
      original = await f.checks.run("local", f.project.id, request);
    });
    assert.ok(original);
    assert.equal(original.sourceSha256, hash("AUROC=0.83"));
    assert.equal(
      (await f.operations.get("local", original.jobId)).purpose,
      "check",
    );
    const current = await f.notebooks.get("local", f.project.id, f.notebook.id);
    await f.notebooks.patch("local", f.project.id, f.notebook.id, {
      revision: current.revision,
      cellId: "Markdown-A",
      source: "The current cell changed.",
    });
    await assert.rejects(
      f.checks.preview("local", f.project.id, { target: markdown }),
      status(409),
    );
    assert.deepEqual(
      await f.checks.run("local", f.project.id, request),
      original,
    );
    await assert.rejects(
      f.checks.run("local", f.project.id, {
        ...request,
        target: { ...markdown, revision: 2 },
      }),
      status(409),
    );
    await assert.rejects(
      f.checks.run("local", f.other.id, request),
      status(409),
    );
    const v2 = new ResearchChecks(f.services, f.state, f.credentials, {
      checkerVersion: "fixture-checker-v2",
    });
    f.cleanup.push(() => v2.close());
    assert.deepEqual(await v2.run("local", f.project.id, request), original);
    const retained = structuredClone(original);
    original.scope.omitted.push("CLIENT_MUTATED");
    assert.deepEqual(
      await f.checks.get("local", f.project.id, retained.id),
      retained,
    );
    await assert.rejects(
      f.checks.get("local", f.other.id, retained.id),
      status(404),
    );
    await assert.rejects(
      f.checks.preview("local", f.project.id, {
        target: { ...markdown, source: "FORGED_CLIENT_REPLACEMENT" },
      }),
      status(400),
    );
    const version = await f.target("Actual canonical file report.");
    await assert.rejects(
      f.checks.preview("local", f.project.id, {
        target: { ...version, sha256: "0".repeat(64) },
      }),
      status(409),
    );
    await assert.rejects(
      f.checks.preview("local", f.other.id, { target: version }),
      status(404),
    );
    assert.deepEqual(
      (await f.admin.query("SELECT count(*)::text FROM grants")).rows,
      grantsBefore.rows,
    );
    assert.deepEqual(
      (
        await f.admin.query(
          "SELECT count(*)::text FROM jobs WHERE purpose IN ('chat','execution')",
        )
      ).rows,
      jobsBefore.rows,
    );
    assert.equal(f.effects.invalidations, 0);
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::text FROM research_check_reports WHERE job_id=$1",
          [retained.jobId],
        )
      ).rows[0].count,
      "1",
    );
    await assert.rejects(
      f.application.query(
        "UPDATE research_check_reports SET report='{}'::jsonb WHERE id=$1",
        [retained.id],
      ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "42501",
    );
    const concurrentRequest = await f.prepared(await f.target("n=19"));
    let concurrent: CheckReport[] | undefined;
    await assert.doesNotReject(async () => {
      concurrent = await Promise.all([
        f.checks.run("local", f.project.id, concurrentRequest),
        f.checks.run("local", f.project.id, concurrentRequest),
      ]);
    });
    assert.ok(concurrent);
    assert.deepEqual(concurrent[0], concurrent[1]);
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::text FROM research_check_reports WHERE job_id=$1",
          [concurrent[0].jobId],
        )
      ).rows[0].count,
      "1",
    );
    const capacityEntered = barrier(),
      capacityRelease = barrier();
    let entering = 0;
    const limited = new ResearchChecks(f.services, f.state, f.credentials, {
      beforePublish: async () => {
        if (++entering === 4) capacityEntered.release();
        await capacityRelease.ready;
      },
    });
    f.cleanup.push(() => limited.close());
    const capacityTarget = await f.target("n=21");
    const preparedCapacity = await Promise.all(
      Array.from({ length: 5 }, () => f.prepared(capacityTarget)),
    );
    const running = preparedCapacity
      .slice(0, 4)
      .map((request) => limited.run("local", f.project.id, request));
    try {
      await bounded(capacityEntered.ready);
      await assert.rejects(
        bounded(limited.run("local", f.project.id, preparedCapacity[4])),
        status(429),
      );
    } finally {
      capacityRelease.release();
    }
    await assert.doesNotReject(() => bounded(Promise.all(running)));
    const captureEntered = barrier(),
      captureRelease = barrier();
    const capturedChecker = new ResearchChecks(
      f.services,
      f.state,
      f.credentials,
      {
        beforePublish: async () => {
          captureEntered.release();
          await captureRelease.ready;
        },
      },
    );
    f.cleanup.push(() => capturedChecker.close());
    const beforeCapture = await f.notebooks.get(
      "local",
      f.project.id,
      f.notebook.id,
    );
    const captureTarget: CheckTarget = {
      ...markdown,
      revision: beforeCapture.revision,
    };
    const capturedPending = capturedChecker.run(
      "local",
      f.project.id,
      await f.prepared(captureTarget),
    );
    try {
      await bounded(captureEntered.ready);
      await f.notebooks.patch("local", f.project.id, f.notebook.id, {
        revision: beforeCapture.revision,
        cellId: "Markdown-A",
        source: "Changed after the server captured it.",
      });
    } finally {
      captureRelease.release();
    }
    const capturedReport = await bounded(capturedPending);
    assert.equal(
      capturedReport.sourceSha256,
      hash("The current cell changed."),
    );
    assert.equal(
      (await f.notebooks.get("local", f.project.id, f.notebook.id)).document
        .cells[0].source,
      "Changed after the server captured it.",
    );
    const project = await f.sessions.open("local", f.project.id);
    await f.projects.archive("local", f.project.id, project.revision);
    assert.deepEqual(
      await f.checks.run("local", f.project.id, request),
      retained,
    );
    await assert.rejects(
      f.checks.run("local", f.project.id, {
        ...request,
        requestId: randomUUID(),
      }),
      status(409),
    );
    const router = checkRoutes(f.checks);
    const response = await router(
      new Request(
        `http://127.0.0.1/api/projects/${f.project.id}/checks/${retained.id}`,
        { headers: { Host: "127.0.0.1" } },
      ),
    );
    assert.equal(response.status, 200);
    const race = await fixture(t);
    const entered = barrier(),
      release = barrier();
    const paused = new ResearchChecks(
      race.services,
      race.state,
      race.credentials,
      {
        beforePublish: async () => {
          entered.release();
          await release.ready;
        },
      },
    );
    race.cleanup.push(() => paused.close());
    const pendingRequest = await race.prepared(await race.target("n=17"));
    const pending = paused.run("local", race.project.id, pendingRequest).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      await bounded(entered.ready);
      const activeProject = await race.sessions.open("local", race.project.id);
      await race.projects.archive(
        "local",
        race.project.id,
        activeProject.revision,
      );
    } finally {
      release.release();
    }
    const archived = await bounded(pending);
    assert.ok(status(409)(archived.error));
    assert.equal(archived.value, undefined);
    assert.equal(
      (
        await race.admin.query(
          "SELECT count(*)::text FROM research_check_reports",
        )
      ).rows[0].count,
      "0",
    );
    const epochEntered = barrier(),
      epochRelease = barrier();
    const epochChecker = new ResearchChecks(
      race.services,
      race.state,
      race.credentials,
      {
        beforePublish: async () => {
          epochEntered.release();
          await epochRelease.ready;
        },
      },
    );
    race.cleanup.push(() => epochChecker.close());
    const epochFile = await race.files.upload(
      "local",
      race.other.id,
      "epoch.md",
      "text/markdown",
      bytes("n=18"),
    );
    const epochTarget: CheckTarget = {
      kind: "file",
      id: epochFile.id,
      sha256: epochFile.sha256,
    };
    const epochPreview = await epochChecker.preview("local", race.other.id, {
      target: epochTarget,
    });
    const epochPending = epochChecker
      .run("local", race.other.id, {
        requestId: randomUUID(),
        target: epochTarget,
        fingerprint: epochPreview.fingerprint,
      })
      .then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
    try {
      await bounded(epochEntered.ready);
      await race.admin.query("UPDATE writer_control SET epoch=epoch+1");
    } finally {
      epochRelease.release();
    }
    const fenced = await bounded(epochPending);
    assert.ok(status(409)(fenced.error));
    assert.equal(fenced.value, undefined);
    assert.equal(
      (
        await race.admin.query(
          "SELECT count(*)::text FROM research_check_reports",
        )
      ).rows[0].count,
      "0",
    );
  },
);
