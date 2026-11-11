import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { once } from "node:events";
import { testDatabase } from "./database";
import { connectDatabase } from "../../src/server/database";
import { createApplication } from "../../src/server/application";
import { Runtime } from "../../src/server/runtime";
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 30000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(label);
    await wait(20);
  }
}
export async function initializationShutdown() {
  const db = await testDatabase(),
    admin = await connectDatabase(db.state, db.credentials, "bootstrap");
  const originalClose = Runtime.prototype.close,
    originalInterval = globalThis.setInterval;
  const intervals = new Set<ReturnType<typeof setInterval>>();
  let closeStarted = false,
    application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let execution: Promise<Response> | undefined,
    closing: Promise<void> | undefined,
    transaction = false;
  Runtime.prototype.close = async function () {
    closeStarted = true;
    return originalClose.call(this);
  };
  globalThis.setInterval = Object.assign(
    (...args: Parameters<typeof setInterval>) => {
      const timer = originalInterval(...args);
      intervals.add(timer);
      return timer;
    },
    originalInterval,
  );
  try {
    application = await createApplication({
      state: db.state,
      auth: async () => ({ isAuthenticated: true }),
    });
    const request = (path: string, value: unknown) =>
      application!.handle(
        new Request(`http://127.0.0.1:31000${path}`, {
          method: "POST",
          headers: {
            Host: "127.0.0.1:31000",
            Origin: "http://127.0.0.1:31000",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(value),
        }),
      );
    const projectResponse = await request("/api/projects", {
      name: "Lifecycle",
      description: "",
    });
    assert.equal(projectResponse.status, 201);
    const project = await projectResponse.json();
    const notebookResponse = await request(
      `/api/projects/${project.id}/notebooks`,
      {
        name: "Initialization",
        document: {
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {},
          cells: [
            {
              id: "Code-A",
              cell_type: "code",
              source: "print(1)",
              metadata: { aira: { language: "python", sharing: [] } },
              outputs: [],
              execution_count: null,
            },
          ],
        },
      },
    );
    assert.equal(notebookResponse.status, 201);
    const notebook = await notebookResponse.json();
    const prepared = await request(
      `/api/projects/${project.id}/confirmations/execution`,
      {
        notebookId: notebook.id,
        cellId: "Code-A",
        revision: notebook.revision,
        inputs: [],
      },
    );
    assert.equal(prepared.status, 201);
    const confirmation = await prepared.json();
    await admin.query("UPDATE runtime_reservations SET image_digest=$1", [
      "sha256:" + "d".repeat(64),
    ]);
    await admin.query("BEGIN");
    transaction = true;
    await admin.query("SELECT * FROM runtime_reservations FOR UPDATE");
    execution = request(
      `/api/projects/${project.id}/notebooks/${notebook.id}/execute`,
      {
        confirmationId: confirmation.id,
        fingerprint: confirmation.fingerprint,
        requestId: crypto.randomUUID(),
      },
    );
    const observer = await connectDatabase(
      db.state,
      db.credentials,
      "bootstrap",
    );
    try {
      await until(
        async () =>
          Boolean(
            (
              await observer.query(
                "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%UPDATE runtime_reservations%'",
              )
            ).rowCount,
          ),
        "INITIALIZATION_BLOCK_NOT_OBSERVED",
      );
    } finally {
      await observer.end();
    }
    closing = application.close();
    assert.equal(
      closeStarted,
      false,
      "Runtime must not close while its initialization is still awaiting the owned database",
    );
  } finally {
    if (transaction) await admin.query("ROLLBACK");
    await execution;
    await (closing ?? application?.close());
    for (const timer of intervals) clearInterval(timer);
    globalThis.setInterval = originalInterval;
    Runtime.prototype.close = originalClose;
    await admin.end();
    await db.cleanup();
  }
}
export async function startupSignalShutdown() {
  const db = await testDatabase();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "test/helpers/startup-signal.ts"],
    {
      env: {
        ...process.env,
        AIRA_STATE_DIR: db.state,
        PORT: "0",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  assert.ok(
    child.stdout && child.stderr,
    "Owned startup child requires captured diagnostics",
  );
  let log = "",
    blocked = false,
    signalled = false,
    handlerAfterStop = false;
  child.stdout.on("data", (chunk) => {
    log += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    log += String(chunk);
  });
  child.on("message", (value) => {
    if (!value || typeof value !== "object" || !("kind" in value)) return;
    if (value.kind === "prepare-blocked") blocked = true;
    if (value.kind === "signal-observed") signalled = true;
    if (value.kind === "handler-after-stop") handlerAfterStop = true;
  });
  const exit = once(child, "exit");
  let exited = false;
  void exit.then(() => {
    exited = true;
  });
  try {
    await until(() => blocked || exited, "STARTUP_PROBE_DEADLINE\n" + log);
    assert.ok(blocked, log);
    child.kill("SIGTERM");
    await until(() => signalled || exited, "SIGNAL_PROBE_DEADLINE");
    assert.ok(signalled, log);
    child.send({ kind: "release-prepare" });
    await until(
      () => handlerAfterStop || exited,
      "STARTUP_DRAIN_DEADLINE\n" + log,
    );
    assert.equal(
      handlerAfterStop,
      false,
      "A stop requested during prepare must not continue to create a listening HTTP server",
    );
    const [code, signal] = await exit;
    assert.equal(code, 0, log);
    assert.equal(signal, null);
  } finally {
    if (!exited) {
      child.kill("SIGTERM");
      await until(() => exited, "OWNED_STARTUP_SHUTDOWN_DEADLINE");
    }
    if (child.connected) child.disconnect();
    await db.cleanup();
  }
}
