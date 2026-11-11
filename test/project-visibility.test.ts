import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  settingsFixture,
  settingsRequest,
  researchFixture,
} from "./helpers/project-settings";
import { ServiceError } from "../src/server/http";
import { Projects } from "../src/server/projects";
import { migrate } from "../scripts/migrate";
import {
  ResearchChecks,
  type CheckTarget,
} from "../src/server/research-checks";
const status = (expected: number) => (error: unknown) =>
  error instanceof ServiceError && error.status === expected;
async function bounded<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("VISIBILITY_CHECK_DEADLINE")),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** @id TEST-VIS-001 @verifies REQ-VIS-001 */
test(
  "TEST-VIS-001 hiding retains research while ordinary routes and admissions refuse it",
  { timeout: 120000 },
  async (t) => {
    const f = await settingsFixture(t),
      p = f.project;
    const research = await researchFixture(f);
    const checks = new ResearchChecks(
      research.services,
      f.state,
      f.credentials,
    );
    f.cleanup.push(() => checks.close());
    const target: CheckTarget = {
      kind: "markdown",
      notebookId: research.notebook.id,
      cellId: "Evidence",
      revision: research.notebook.revision,
    };
    const preview = await checks.preview("local", p.id, { target });
    const checkRequest = {
      target,
      fingerprint: preview.fingerprint,
      requestId: randomUUID(),
    };
    const report = await checks.run("local", p.id, checkRequest);
    const intent = await f.intent();
    const priorJob = await f.projects.admit("local", p.id, intent);
    await f.operations.requestCancel("local", priorJob.id);
    await f.operations.finish("local", priorJob.id, "cancelled");
    const before = (
      await f.admin.query("SELECT * FROM chats WHERE project_id=$1", [p.id])
    ).rows;
    let hidden: Awaited<ReturnType<Projects["hide"]>> | undefined;
    await assert.doesNotReject(async () => {
      hidden = await f.projects.hide("local", p.id, p.revision);
    });
    assert.ok(hidden);
    assert.equal(hidden.revision, p.revision + 1);
    assert.equal(hidden.status, p.status);
    assert.deepEqual(await f.projects.list("local"), []);
    assert.deepEqual(
      (await f.admin.query("SELECT * FROM chats WHERE project_id=$1", [p.id]))
        .rows,
      before,
    );
    for (const [method, suffix, body] of [
      ["GET", "", undefined],
      ["PATCH", "", { name: "forbidden", revision: hidden.revision }],
      ["POST", "/archive", { revision: hidden.revision }],
    ] as const)
      assert.equal(
        (
          await f.route(
            settingsRequest(`/api/projects/${p.id}${suffix}`, method, body),
          )
        ).status,
        404,
      );
    await assert.rejects(f.sessions.history("local", p.id), status(404));
    await assert.rejects(checks.run("local", p.id, checkRequest), status(404));
    await assert.rejects(checks.get("local", p.id, report.id), status(404));
    await assert.rejects(
      research.files.get("local", p.id, research.file.id),
      status(404),
    );
    await assert.rejects(
      research.notebooks.get("local", p.id, research.notebook.id),
      status(404),
    );
    await assert.rejects(f.projects.admit("local", p.id, intent), status(404));
    const freshIntent = await f.intent();
    await assert.rejects(
      f.projects.admit("local", p.id, freshIntent),
      status(404),
    );
    assert.equal(
      (
        await f.admin.query("SELECT consumed_by FROM grants WHERE id=$1", [
          freshIntent.grantId,
        ])
      ).rows[0].consumed_by,
      null,
    );
    assert.equal(
      (
        await f.admin.query("SELECT id FROM file_versions WHERE id=$1", [
          research.file.id,
        ])
      ).rowCount,
      1,
    );
    await research.files.storage.verify(
      research.file.blobId,
      research.file.size,
      research.file.sha256,
    );
  },
);

/** @id TEST-VIS-002 @verifies REQ-VIS-002 */
test(
  "TEST-VIS-002 deleted list and restored identities survive reload/migration; archived remains read-only",
  { timeout: 120000 },
  async (t) => {
    const f = await settingsFixture(t),
      p = f.project;
    const research = await researchFixture(f);
    await assert.doesNotReject(async () => {
      await f.projects.hide("local", p.id, 1);
    });
    await f.projects.hide("other", f.foreign.id, 1);
    const list = await f.projects.deleted("local");
    assert.deepEqual(
      list.map((row) => row.id),
      [p.id],
    );
    await migrate(f.state, f.credentials);
    const reloaded = new Projects(
      f.operations,
      f.sessions,
      f.state,
      f.credentials,
    );
    f.cleanup.push(() => reloaded.close());
    const restored = await reloaded.restore("local", p.id, list[0].revision);
    assert.equal(restored.chatId, p.chatId);
    assert.equal(restored.status, "active");
    assert.equal(restored.revision, 3);
    assert.deepEqual(
      await research.files.get("local", p.id, research.file.id),
      research.file,
    );
    assert.deepEqual(
      await research.notebooks.get("local", p.id, research.notebook.id),
      research.notebook,
    );
    assert.deepEqual(await reloaded.deleted("local"), []);
    let enteredCount = 0,
      release!: () => void,
      entered!: () => void;
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const allEntered = new Promise<void>((done) => {
      entered = done;
    });
    const checks = new ResearchChecks(
      research.services,
      f.state,
      f.credentials,
      {
        beforePublish: async () => {
          if (++enteredCount === 4) entered();
          await hold;
        },
      },
    );
    const control = new ResearchChecks(
      research.services,
      f.state,
      f.credentials,
    );
    f.cleanup.push(
      () => checks.close(),
      () => control.close(),
    );
    const target: CheckTarget = {
      kind: "markdown",
      notebookId: research.notebook.id,
      cellId: "Evidence",
      revision: research.notebook.revision,
    };
    const preview = await checks.preview("local", p.id, { target });
    const pending = Array.from({ length: 4 }, () =>
      checks
        .run("local", p.id, {
          target,
          fingerprint: preview.fingerprint,
          requestId: randomUUID(),
        })
        .then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        ),
    );
    let hiddenDuringChecks: Awaited<ReturnType<Projects["hide"]>> | undefined;
    try {
      await bounded(allEntered);
      hiddenDuringChecks = await reloaded.hide(
        "local",
        p.id,
        restored.revision,
      );
      const other = await reloaded.create("local", {
        name: "Check capacity control",
      });
      const otherNotebook = await research.notebooks.create("local", other.id, {
        name: "Control source",
        document: {
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {},
          cells: [
            {
              id: "Evidence",
              cell_type: "markdown",
              source: "Control source",
              metadata: {},
            },
          ],
        },
      });
      const otherTarget: CheckTarget = {
        kind: "markdown",
        notebookId: otherNotebook.id,
        cellId: "Evidence",
        revision: otherNotebook.revision,
      };
      const otherPreview = await control.preview("local", other.id, {
        target: otherTarget,
      });
      await assert.doesNotReject(
        control.run("local", other.id, {
          target: otherTarget,
          fingerprint: otherPreview.fingerprint,
          requestId: randomUUID(),
        }),
      );
    } finally {
      release();
      await bounded(Promise.all(pending));
    }
    const outcomes = await bounded(Promise.all(pending));
    assert.ok(
      outcomes.every(
        (outcome) => status(404)(outcome.error) && outcome.value === undefined,
      ),
    );
    const checkJobs = await f.admin.query<{ state: string }>(
      "SELECT state FROM jobs WHERE project_id=$1 AND purpose='check'",
      [p.id],
    );
    assert.equal(checkJobs.rowCount, 4);
    assert.ok(
      checkJobs.rows.every((job) => job.state === "failed"),
      "hidden checks must terminate rather than consume capacity forever",
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT id FROM research_check_reports WHERE project_id=$1",
          [p.id],
        )
      ).rowCount,
      0,
    );
    assert.ok(hiddenDuringChecks);
    const afterChecks = await reloaded.restore(
      "local",
      p.id,
      hiddenDuringChecks.revision,
    );
    const archived = await reloaded.archive(
      "local",
      p.id,
      afterChecks.revision,
    );
    const archivedHidden = await reloaded.hide(
      "local",
      p.id,
      archived.revision,
    );
    const archivedRestored = await reloaded.restore(
      "local",
      p.id,
      archivedHidden.revision,
    );
    assert.equal(archivedRestored.status, "archived");
    await assert.rejects(
      reloaded.edit("local", p.id, {
        revision: archivedRestored.revision,
        name: "forbidden",
      }),
      status(409),
    );
    assert.equal(
      (await f.route(settingsRequest("/api/projects/deleted"))).status,
      200,
    );
  },
);

/** @id TEST-VIS-003 @verifies REQ-VIS-003 */
test(
  "TEST-VIS-003 invalid/stale/foreign/busy visibility changes and admission race preserve fences",
  { timeout: 120000 },
  async (t) => {
    const f = await settingsFixture(t),
      p = f.project;
    await assert.rejects(f.projects.hide("local", p.id, 0), status(400));
    for (const id of [randomUUID(), f.foreign.id])
      await assert.rejects(f.projects.hide("local", id, 1), status(404));
    await assert.rejects(f.projects.restore("local", p.id, 1), status(409));
    await assert.rejects(f.projects.hide("local", p.id, 2), status(409));
    const busy = await f.projects.create("local", { name: "busy control" });
    const running = await f.projects.admit("local", busy.id, await f.intent());
    await assert.rejects(
      f.projects.hide("local", busy.id, busy.revision),
      status(409),
    );
    assert.equal(
      (await f.projects.get("local", busy.id)).revision,
      busy.revision,
    );
    await f.operations.requestCancel("local", running.id);
    await f.operations.finish("local", running.id, "cancelled");
    const busyHidden = await f.projects.hide("local", busy.id, busy.revision);
    await f.projects.restore("local", busy.id, busyHidden.revision);
    const intent = await f.intent();
    const outcomes = await Promise.allSettled([
      f.projects.hide("local", p.id, 1),
      f.projects.admit("local", p.id, intent),
    ]);
    assert.equal(
      outcomes.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const failed = outcomes.find((result) => result.status === "rejected");
    assert.ok(failed?.status === "rejected");
    assert.ok(failed.reason instanceof ServiceError);
    if (outcomes[0].status === "fulfilled") {
      assert.equal(failed.reason.status, 404);
      await assert.rejects(f.projects.hide("local", p.id, 2), status(409));
      await assert.rejects(f.projects.restore("local", p.id, 1), status(409));
      await f.projects.restore("local", p.id, 2);
    } else {
      assert.equal(failed.reason.status, 409);
      assert.equal((await f.projects.get("local", p.id)).revision, 1);
      const job = outcomes[1];
      assert.ok(job.status === "fulfilled");
      await f.operations.requestCancel("local", job.value.id);
      await f.operations.finish("local", job.value.id, "cancelled");
      await f.projects.hide("local", p.id, 1);
    }
    assert.equal(
      (await f.admin.query("SELECT COUNT(*)::integer AS count FROM projects"))
        .rows[0].count,
      3,
    );
  },
);
