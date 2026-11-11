import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { chmod, lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { testDatabase } from "./helpers/database";
import { testContainer } from "./helpers/containers";
import { Operations, type Purpose } from "../src/server/operations";
import { connectDatabase, databaseConfig } from "../src/server/database";
import { loadCredentials } from "../src/server/credentials";
import {
  startDatabase,
  validateDatabaseInspection,
} from "../src/server/db-container";
import {
  inspectOwned,
  removeOwned,
  stopOwned,
} from "../src/server/owned-containers";
import { ServiceError } from "../src/server/http";
import pg from "pg";

const fingerprint = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const isCode = (code: string) => (error: unknown) =>
  error instanceof ServiceError && error.code === code;
function teardown(t: TestContext) {
  const actions: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const action of actions.reverse()) await action();
  });
  return (action: () => Promise<unknown>) => actions.push(action);
}
async function admitted(
  operations: Operations,
  purpose: Purpose = "execution",
  text = randomUUID(),
) {
  const actor = "local";
  const hash = fingerprint(text);
  const grantId = await operations.grant(actor, purpose, hash);
  const input = {
    actor,
    purpose,
    fingerprint: hash,
    requestId: randomUUID(),
    grantId,
  };
  return { input, job: await operations.admit(input) };
}

/** @id TEST-OPS-001 @verifies REQ-OPS-001 */
test(
  "TEST-OPS-001 durable lifecycle; stale-epoch commit refusal and truthful unknown start",
  { timeout: 120000 },
  async (t) => {
    const after = teardown(t);
    const db = await testDatabase();
    after(() => db.cleanup());
    const operations = new Operations(db.state, db.credentials);
    after(() => operations.close());
    await operations.acquire();
    const { job } = await admitted(operations);
    assert.equal(job.state, "queued");
    assert.equal(job.started, "unknown");
    const observer = await connectDatabase(
      db.state,
      db.credentials,
      "application",
    );
    after(() => observer.end());
    assert.equal(
      (await observer.query("SELECT state FROM jobs WHERE id=$1", [job.id]))
        .rows[0].state,
      "queued",
    );
    const running = await operations.dispatch("local", job.id);
    assert.equal(
      running.started,
      "unknown",
      "dispatch intent is not proof of execution",
    );
    await assert.rejects(
      operations.finish("local", job.id, "completed"),
      isCode("JOB_NOT_COMPLETABLE"),
      "unknown execution must never become completed",
    );
    await operations.observeStarted("local", job.id);
    const completed = await operations.finish("local", job.id, "completed");
    assert.equal(completed.state, "completed");
    assert.equal(completed.started, "observed");
    assert.equal(
      completed.cleanup,
      "unknown",
      "no owned process has been observed stopped",
    );
    await assert.rejects(
      operations.finish("local", job.id, "failed"),
      isCode("JOB_TERMINAL_OR_FOREIGN"),
    );
    await assert.rejects(
      operations.get("foreign", job.id),
      isCode("JOB_NOT_FOUND"),
    );
    for (const terminal of ["failed", "timeout", "interrupted"] as const) {
      const uncertain = (await admitted(operations)).job;
      await operations.dispatch("local", uncertain.id);
      const outcome = await operations.finish("local", uncertain.id, terminal);
      assert.equal(outcome.state, terminal);
      assert.equal(outcome.started, "unknown");
      assert.equal(outcome.cleanup, "unknown");
    }

    const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
    after(() => admin.end());
    const stale = (await admitted(operations)).job;
    await operations.dispatch("local", stale.id);
    await admin.query(
      "UPDATE writer_control SET epoch=epoch+1 WHERE singleton",
    );
    await assert.rejects(
      operations.finish("local", stale.id, "completed"),
      isCode("WRITER_FENCE_REJECTED"),
    );
    assert.equal((await operations.get("local", stale.id)).state, "running");
    await operations.close();
    const next = new Operations(db.state, db.credentials);
    after(() => next.close());
    await next.acquire();
    const recovered = await next.get("local", stale.id);
    assert.equal(recovered.state, "interrupted");
    assert.equal(recovered.started, "unknown");
    await assert.rejects(
      next.dispatch("local", stale.id),
      isCode("JOB_NOT_DISPATCHABLE"),
    );

    const lost = (await admitted(next)).job;
    await next.dispatch("local", lost.id);
    const pid = (await admin.query("SELECT backend_pid FROM writer_control"))
      .rows[0].backend_pid;
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await assert.rejects(next.finish("local", lost.id, "completed"));
    assert.equal((await next.get("local", lost.id)).state, "running");
    await assert.rejects(
      next.grant("local", "advisory", fingerprint("no admission")),
    );
  },
);
/** @id TEST-OPS-002 @verifies REQ-OPS-002 */
test(
  "TEST-OPS-002 same-intent receipt replay; changed intent and cancel/complete race",
  { timeout: 120000 },
  async (t) => {
    const after = teardown(t);
    const db = await testDatabase();
    after(() => db.cleanup());
    const operations = new Operations(db.state, db.credentials);
    after(() => operations.close());
    await operations.acquire();
    const { input, job } = await admitted(operations, "chat");
    const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
    after(() => admin.end());
    await admin.query(
      "UPDATE grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [input.grantId],
    );
    const repeats = await Promise.all(
      Array.from({ length: 12 }, () => operations.admit(input)),
    );
    assert.deepEqual(
      repeats.map((value) => value.id),
      Array(12).fill(job.id),
    );
    await assert.rejects(
      operations.admit({ ...input, fingerprint: fingerprint("changed") }),
      isCode("REQUEST_INTENT_CONFLICT"),
    );
    await assert.rejects(
      operations.admit({ ...input, purpose: "execution" }),
      isCode("REQUEST_INTENT_CONFLICT"),
    );
    await assert.rejects(
      operations.admit({ ...input, requestId: randomUUID() }),
      isCode("CONFIRMATION_REQUIRED"),
    );
    await assert.rejects(
      operations.admit({ ...input, actor: "foreign" }),
      isCode("CONFIRMATION_REQUIRED"),
    );
    assert.equal(
      Number((await admin.query("SELECT count(*) FROM jobs")).rows[0].count),
      1,
    );
    const boundHash = fingerprint("exact grant payload");
    const boundGrant = await operations.grant("local", "execution", boundHash);
    const boundInput = {
      actor: "local",
      purpose: "execution" as const,
      fingerprint: boundHash,
      requestId: randomUUID(),
      grantId: boundGrant,
    };
    for (const mismatch of [
      { ...boundInput, actor: "foreign" },
      { ...boundInput, purpose: "advisory" as const },
      { ...boundInput, fingerprint: fingerprint("different payload") },
    ]) {
      await assert.rejects(
        operations.admit(mismatch),
        isCode("CONFIRMATION_REQUIRED"),
      );
    }
    const boundJob = await operations.admit(boundInput);
    assert.equal(boundJob.purpose, "execution");
    await assert.rejects(
      operations.admit({ ...boundInput, requestId: randomUUID() }),
      isCode("CONFIRMATION_REQUIRED"),
    );
    const expired = await operations.grant("local", "execution", boundHash);
    await admin.query(
      "UPDATE grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [expired],
    );
    await assert.rejects(
      operations.admit({
        ...boundInput,
        grantId: expired,
        requestId: randomUUID(),
      }),
      isCode("CONFIRMATION_REQUIRED"),
    );
    assert.equal(
      (await operations.requestCancel("local", job.id)).state,
      "queued",
    );
    assert.equal(
      (await operations.finish("local", job.id, "cancelled")).cleanup,
      "verified",
    );
    assert.equal(
      (await operations.get("local", job.id)).started,
      "not-started",
    );
    assert.equal((await operations.admit(input)).id, job.id);

    const unproven = (await admitted(operations)).job;
    await operations.dispatch("local", unproven.id);
    await operations.requestCancel("local", unproven.id);
    await assert.rejects(
      operations.finish("local", unproven.id, "cancelled"),
      isCode("STOP_UNCONFIRMED"),
    );
    assert.equal((await operations.get("local", unproven.id)).state, "running");
    const noStart = (await admitted(operations)).job;
    await operations.dispatch("local", noStart.id);
    await assert.rejects(
      operations.finish("local", noStart.id, "completed"),
      isCode("JOB_NOT_COMPLETABLE"),
    );

    for (const cancelFirst of [true, false]) {
      const active = (await admitted(operations)).job;
      await operations.dispatch("local", active.id);
      const container = await testContainer(db.credentials, active.id);
      after(() => removeOwned(container));
      await operations.registerContainer("local", active.id, container);
      await operations.observeStarted("local", active.id);
      assert.equal((await inspectOwned(container)).State.Running, true);
      if (cancelFirst) {
        const admissionRace = await Promise.allSettled([
          operations.requestCancel("local", active.id),
          operations.finish("local", active.id, "completed"),
        ]);
        assert.equal(
          admissionRace.filter((result) => result.status === "fulfilled")
            .length,
          1,
        );
        await operations.finish("local", active.id, "cancelled");
        assert.equal(
          (await operations.get("local", active.id)).state,
          "cancelled",
        );
      } else {
        const completionRace = await Promise.allSettled([
          operations.finish("local", active.id, "completed"),
          operations.requestCancel("local", active.id),
        ]);
        assert.equal(completionRace[0].status, "fulfilled");
        assert.equal(completionRace[1].status, "rejected");
        assert.equal(
          (await operations.get("local", active.id)).state,
          "completed",
        );
      }
      assert.equal((await inspectOwned(container)).State.Running, false);
    }
  },
);
/** @id TEST-OPS-003 @verifies REQ-OPS-003 */
test(
  "TEST-OPS-003 private DB writer lease; owned cleanup, lease loss and no dispatch replay",
  { timeout: 120000 },
  async (t) => {
    const after = teardown(t);
    const db = await testDatabase();
    after(() => db.cleanup());
    const before = await readFile(join(db.state, "credentials.json"));
    assert.equal((await lstat(db.state)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(db.state, "socket"))).mode & 0o777, 0o700);
    assert.equal(
      (await lstat(join(db.state, "credentials.json"))).mode & 0o777,
      0o600,
    );
    assert.equal(db.version.split(" ")[0], "17.11");
    const validIsolation = await inspectOwned(db.identity);
    assert.equal(
      validateDatabaseInspection(validIsolation, db.state).Id,
      db.identity.id,
    );
    for (const invalidIsolation of [
      { ...validIsolation, Image: "sha256:" + "0".repeat(64) },
      {
        ...validIsolation,
        Config: { ...validIsolation.Config, Image: "unapproved-image" },
      },
      {
        ...validIsolation,
        HostConfig: { ...validIsolation.HostConfig, Privileged: true },
      },
      {
        ...validIsolation,
        HostConfig: { ...validIsolation.HostConfig, CapAdd: ["SYS_ADMIN"] },
      },
      {
        ...validIsolation,
        HostConfig: { ...validIsolation.HostConfig, Devices: [{}] },
      },
      {
        ...validIsolation,
        Mounts: [
          ...validIsolation.Mounts,
          { Type: "bind", Source: "/unsafe", Destination: "/extra", RW: true },
        ],
      },
    ]) {
      assert.throws(
        () => validateDatabaseInspection(invalidIsolation, db.state),
        isCode("DATABASE_ISOLATION_MISMATCH"),
      );
    }
    assert.equal(
      new Set([
        db.credentials.bootstrap,
        db.credentials.migration,
        db.credentials.application,
      ]).size,
      3,
    );
    const wrong = new pg.Client({
      ...databaseConfig(db.state, db.credentials, "application"),
      password: "invalid",
    });
    await assert.rejects(
      wrong.connect(),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "28P01",
    );
    await wrong.end();
    const application = await connectDatabase(
      db.state,
      db.credentials,
      "application",
    );
    after(() => application.end());
    const privileges = (
      await application.query(
        "SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.deepEqual(privileges, {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    await assert.rejects(
      application.query("CREATE TABLE forbidden (id integer)"),
    );
    await assert.rejects(application.query("CREATE ROLE forbidden"));
    await assert.rejects(application.query("DROP TABLE jobs"));
    await chmod(join(db.state, "credentials.json"), 0o644);
    try {
      await assert.rejects(
        loadCredentials(db.state),
        isCode("UNSAFE_STATE_FILE"),
      );
    } finally {
      await chmod(join(db.state, "credentials.json"), 0o600);
    }
    const first = new Operations(db.state, db.credentials);
    const second = new Operations(db.state, db.credentials);
    after(() => first.close());
    after(() => second.close());
    await first.acquire();
    await assert.rejects(second.acquire(), isCode("WRITER_ALREADY_ACTIVE"));
    const active = (await admitted(first)).job;
    await first.dispatch("local", active.id);
    const owned = await testContainer(db.credentials, active.id);
    const foreign = await testContainer({
      ...db.credentials,
      applicationId: randomUUID(),
      controlId: randomUUID(),
    });
    after(() => removeOwned(owned));
    after(() => removeOwned(foreign));
    await first.registerContainer("local", active.id, owned);
    await first.close();
    const recovered = new Operations(db.state, db.credentials);
    after(() => recovered.close());
    await recovered.acquire();
    assert.equal(
      (await recovered.get("local", active.id)).state,
      "interrupted",
    );
    assert.equal((await inspectOwned(owned)).State.Running, false);
    assert.equal((await recovered.get("local", active.id)).cleanup, "verified");
    assert.equal((await inspectOwned(foreign)).State.Running, true);
    await assert.rejects(
      recovered.dispatch("local", active.id),
      isCode("JOB_NOT_DISPATCHABLE"),
    );

    // A restored DB record is not authority to control another installation's process.
    const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
    after(() => admin.end());
    const shutdownJob = (await admitted(recovered)).job;
    await recovered.dispatch("local", shutdownJob.id);
    const shutdownContainer = await testContainer(
      db.credentials,
      shutdownJob.id,
    );
    after(() => removeOwned(shutdownContainer));
    await recovered.registerContainer(
      "local",
      shutdownJob.id,
      shutdownContainer,
    );
    await admin.query("BEGIN");
    await admin.query("SELECT singleton FROM writer_control FOR UPDATE");
    const shutdown = recovered.shutdown();
    const lateGrant = assert.rejects(
      recovered.grant("local", "execution", fingerprint("late admission")),
      isCode("WRITER_LEASE_UNAVAILABLE"),
    );
    await admin.query("COMMIT");
    await lateGrant;
    await shutdown;
    assert.equal((await inspectOwned(shutdownContainer)).State.Running, false);
    const continued = new Operations(db.state, db.credentials);
    after(() => continued.close());
    await continued.acquire();
    assert.equal(
      (await continued.get("local", shutdownJob.id)).state,
      "interrupted",
    );
    const unresolved = (await admitted(continued)).job;
    await continued.dispatch("local", unresolved.id);
    await admin.query(
      `INSERT INTO operation_containers(id,application_id,control_id,resource_id,job_id)
      VALUES($1,$2,$3,$4,$5)`,
      [
        foreign.id,
        foreign.applicationId,
        foreign.controlId,
        foreign.resourceId,
        unresolved.id,
      ],
    );
    await continued.close();
    const blocked = new Operations(db.state, db.credentials);
    after(() => blocked.close());
    await assert.rejects(
      blocked.acquire(),
      isCode("RESTORED_CONTAINER_IDENTITY_INERT"),
    );
    assert.equal(
      (await blocked.get("local", unresolved.id)).state,
      "interrupted",
      "cleanup failure must not roll back the durable interrupted lifecycle",
    );
    await assert.rejects(
      blocked.grant("local", "execution", fingerprint("blocked reuse")),
    );
    assert.equal((await inspectOwned(foreign)).State.Running, true);
    await blocked.close();
    await application.end();
    await admin.end();
    await stopOwned(db.identity);
    await startDatabase(db.state);
    assert.deepEqual(
      await readFile(join(db.state, "credentials.json")),
      before,
    );
    const reconnected = await connectDatabase(
      db.state,
      db.credentials,
      "application",
    );
    try {
      assert.equal(
        (
          await reconnected.query("SELECT state FROM jobs WHERE id=$1", [
            active.id,
          ])
        ).rows[0].state,
        "interrupted",
      );
    } finally {
      await reconnected.end();
    }
  },
);
