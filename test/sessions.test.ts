import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { testDatabase } from "./helpers/database";
import { testContainer } from "./helpers/containers";
import { connectDatabase } from "../src/server/database";
import { Operations } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { ServiceError } from "../src/server/http";
import { removeOwned } from "../src/server/owned-containers";
import type {
  ExcerptResolver,
  ExcerptSelection,
} from "../src/server/chat-context";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const code = (expected: string) => (error: unknown) =>
  error instanceof ServiceError && error.code === expected;
const status = (expected: number) => (error: unknown) =>
  error instanceof ServiceError && error.status === expected;
async function fixture(t: TestContext, resolver?: ExcerptResolver) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const action of cleanup.reverse()) await action();
  });
  const db = await testDatabase();
  cleanup.push(() => db.cleanup());
  const operations = new Operations(db.state, db.credentials);
  cleanup.push(() => operations.close());
  await operations.acquire();
  const sessions = new Sessions(operations, db.state, db.credentials, resolver);
  cleanup.push(() => sessions.close());
  const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
  cleanup.push(() => admin.end());
  async function seed(
    actor = "local",
  ): Promise<{ projectId: string; chatId: string; actor: string }> {
    const projectId = randomUUID(),
      chatId = randomUUID();
    await admin.query("BEGIN");
    try {
      await admin.query(
        "INSERT INTO projects(id,actor,chat_id,name) VALUES($1,$2,$3,'fixture')",
        [projectId, actor, chatId],
      );
      await admin.query(
        "INSERT INTO chats(id,project_id,actor) VALUES($1,$2,$3)",
        [chatId, projectId, actor],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
    return { projectId, chatId, actor };
  }
  async function seedTurn(
    project: Awaited<ReturnType<typeof seed>>,
    prompt = "question",
    response = "",
    state: "running" | "completed" | "failed" = "running",
  ) {
    const jobId = randomUUID(),
      turnId = randomUUID();
    await admin.query(
      `INSERT INTO jobs(id,actor,request_id,purpose,fingerprint,epoch,state,started)
      SELECT $1,$2,$3,'chat',$4,epoch,$5,'observed' FROM writer_control`,
      [jobId, project.actor, randomUUID(), hash(prompt), state],
    );
    await admin.query(
      `INSERT INTO chat_turns(id,project_id,chat_id,actor,job_id,prompt,response)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        turnId,
        project.projectId,
        project.chatId,
        project.actor,
        jobId,
        prompt,
        response,
      ],
    );
    return { turnId, jobId };
  }
  return { ...db, operations, sessions, admin, seed, seedTurn, cleanup };
}
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("SSE frame deadline exceeded")),
          10000,
        );
      }),
    ]);
    assert.equal(value.done, false);
    const text = new TextDecoder().decode(value.value);
    assert.equal(
      text.split("\n\n").filter(Boolean).length,
      1,
      "one bounded SSE frame",
    );
    const event = text.match(/^event: (\w+)$/m)?.[1];
    const data = JSON.parse(text.match(/^data: (.+)$/m)![1]);
    return { event, data, text };
  } finally {
    clearTimeout(timer);
  }
}

/** @id TEST-SESSION-001 @verifies REQ-SESSION-001 */
test(
  "TEST-SESSION-001 atomic exact-one project chat; rollback, concurrency and stable title/history",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const pgCode = (expected: string) => (error: unknown) =>
      error instanceof Error && "code" in error && error.code === expected;
    let created!: Awaited<ReturnType<Sessions["createProject"]>>;
    await assert.doesNotReject(async () => {
      created = await f.sessions.createProject("local", "  研究🧪  ", "説明");
    }, "project and its mandatory single chat must be created atomically");
    assert.equal(created.name, "研究🧪");
    assert.equal(created.chatTitle, "チャット");
    const opens = await Promise.all(
      Array.from({ length: 48 }, () => f.sessions.open("local", created.id)),
    );
    assert.deepEqual(
      opens.map((row) => row.chatId),
      Array(48).fill(created.chatId),
    );
    const historical = await f.seedTurn(
      { projectId: created.id, chatId: created.chatId, actor: "local" },
      "original",
      "retained",
      "completed",
    );
    const renamed = await f.sessions.rename(
      "local",
      created.id,
      "  🧪".repeat(1) + "題名  ",
    );
    assert.equal(renamed.chatId, created.chatId);
    assert.equal(renamed.chatTitle, "🧪題名");
    assert.equal(
      (await f.sessions.history("local", created.id)).turns[0].id,
      historical.turnId,
    );
    assert.equal(
      (await f.sessions.open("local", created.id)).chatTitle,
      "🧪題名",
    );
    for (const invalid of ["", " \n ", "a".repeat(121), "🧪".repeat(121)]) {
      await assert.rejects(
        f.sessions.rename("local", created.id, invalid),
        status(400),
      );
    }
    assert.equal(
      (await f.sessions.rename("local", created.id, "🧪".repeat(120)))
        .chatTitle,
      "🧪".repeat(120),
    );
    await assert.rejects(f.sessions.open("foreign", created.id), status(404));
    await assert.rejects(f.sessions.open("local", "invalid"), status(400));
    await assert.rejects(f.sessions.open("local", randomUUID()), status(404));
    await assert.rejects(
      f.sessions.rename("foreign", created.id, "hidden"),
      status(404),
    );
    const many = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        f.sessions.createProject("local", `parallel-${i}`),
      ),
    );
    assert.equal(new Set(many.map((row) => row.chatId)).size, 20);
    assert.equal(
      Number(
        (
          await f.admin.query(
            "SELECT count(*) FROM chats WHERE project_id=$1",
            [created.id],
          )
        ).rows[0].count,
      ),
      1,
    );
    await assert.rejects(
      f.admin.query(
        "INSERT INTO chats(id,project_id,actor) VALUES($1,$2,'local')",
        [randomUUID(), created.id],
      ),
      pgCode("23505"),
    );
    const application = await connectDatabase(
      f.state,
      f.credentials,
      "application",
    );
    f.cleanup.push(() => application.end());
    assert.equal(
      (
        await application.query("SELECT id FROM chats WHERE id=$1", [
          created.chatId,
        ])
      ).rowCount,
      1,
    );
    await assert.rejects(
      application.query("DELETE FROM chats WHERE id=$1", [created.chatId]),
      pgCode("42501"),
    );
    await assert.rejects(
      application.query("UPDATE chats SET project_id=$1 WHERE id=$2", [
        many[0].id,
        created.chatId,
      ]),
      pgCode("42501"),
    );
    await assert.rejects(
      application.query("UPDATE projects SET chat_id=$1 WHERE id=$2", [
        created.chatId,
        created.id,
      ]),
      pgCode("42501"),
    );
    await assert.rejects(
      application.query("UPDATE projects SET actor='other' WHERE id=$1", [
        created.id,
      ]),
      pgCode("42501"),
    );
    for (const missing of ["chat", "project"]) {
      const projectId = randomUUID(),
        chatId = randomUUID();
      await f.admin.query("BEGIN");
      try {
        await assert.rejects(async () => {
          if (missing === "chat") {
            await f.admin.query(
              "INSERT INTO projects(id,actor,chat_id,name) VALUES($1,'local',$2,'missing-chat')",
              [projectId, chatId],
            );
          } else {
            await f.admin.query(
              "INSERT INTO chats(id,project_id,actor) VALUES($1,$2,'local')",
              [chatId, projectId],
            );
          }
          await f.admin.query("COMMIT");
        }, pgCode("23503"));
      } finally {
        await f.admin.query("ROLLBACK");
      }
      assert.equal(
        (
          await f.admin.query("SELECT id FROM projects WHERE id=$1", [
            projectId,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (await f.admin.query("SELECT id FROM chats WHERE id=$1", [chatId]))
          .rowCount,
        0,
      );
    }
    const reverseProject = randomUUID(),
      reverseChat = randomUUID();
    await assert.doesNotReject(async () => {
      await f.admin.query("BEGIN");
      await f.admin.query(
        "INSERT INTO chats(id,project_id,actor) VALUES($1,$2,'local')",
        [reverseChat, reverseProject],
      );
      await f.admin.query(
        "INSERT INTO projects(id,actor,chat_id,name) VALUES($1,'local',$2,'reverse-order-valid')",
        [reverseProject, reverseChat],
      );
      await f.admin.query("COMMIT");
    }, "deferred project/chat associations must retain their valid reverse insertion order");
    assert.equal(
      (await f.sessions.open("local", reverseProject)).chatId,
      reverseChat,
    );
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int AS n FROM project_lab_notes WHERE project_id=$1",
          [reverseProject],
        )
      ).rows[0].n,
      1,
    );
    const foreign = await f.seed("other");
    const foreignAssociationJob = randomUUID();
    await f.admin.query(
      `INSERT INTO jobs(id,actor,request_id,purpose,fingerprint,epoch,state)
      SELECT $1,'local',$2,'chat',$3,epoch,'queued' FROM writer_control`,
      [
        foreignAssociationJob,
        randomUUID(),
        hash("foreign-association-control"),
      ],
    );
    await assert.rejects(
      f.admin.query(
        `INSERT INTO chat_turns(id,project_id,chat_id,actor,job_id,prompt)
      VALUES($1,$2,$3,'local',$4,'foreign')`,
        [randomUUID(), created.id, foreign.chatId, foreignAssociationJob],
      ),
      pgCode("23503"),
    );
    await f.admin
      .query(`CREATE FUNCTION reject_fixture_chat() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic creation failure'; END $$`);
    await f.admin.query(
      "CREATE TRIGGER fail_fixture_chat BEFORE INSERT ON chats FOR EACH ROW EXECUTE FUNCTION reject_fixture_chat()",
    );
    try {
      await assert.rejects(f.sessions.createProject("local", "must-rollback"));
      assert.equal(
        Number(
          (
            await f.admin.query(
              "SELECT count(*) FROM projects WHERE name='must-rollback'",
            )
          ).rows[0].count,
        ),
        0,
      );
    } finally {
      await f.admin.query("DROP TRIGGER fail_fixture_chat ON chats");
    }
    await f.admin.query("UPDATE projects SET status='archived' WHERE id=$1", [
      created.id,
    ]);
    await assert.rejects(
      f.sessions.rename("local", created.id, "no"),
      status(409),
    );
    assert.equal(
      (await f.sessions.open("local", created.id)).chatId,
      created.chatId,
    );
    const orphan = await f.sessions.createProject(
      "local",
      "broken restore fixture",
    );
    await f.admin.query(
      "ALTER TABLE projects DROP CONSTRAINT project_exact_chat",
    );
    await f.admin.query(
      "ALTER TABLE notebook_links DROP CONSTRAINT notebook_links_chat_id_project_id_actor_fkey",
    );
    await f.admin.query("DELETE FROM chats WHERE id=$1", [orphan.chatId]);
    await assert.rejects(
      f.sessions.open("local", orphan.id),
      code("PROJECT_CHAT_INVARIANT_BROKEN"),
    );
    assert.equal(
      Number(
        (
          await f.admin.query(
            "SELECT count(*) FROM chats WHERE project_id=$1",
            [orphan.id],
          )
        ).rows[0].count,
      ),
      0,
    );
  },
);
/** @id TEST-SESSION-002 @verifies REQ-SESSION-002 */
test(
  "TEST-SESSION-002 bounded SSE; terminal success only, failure and cancellation",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const project = await f.seed();
    const active = await f.seedTurn(project);
    await assert.doesNotReject(
      f.sessions.recordEvent("local", project.projectId, active.turnId, {
        kind: "partial",
        text: "partial\n\nevent: completed",
      }),
      "partial events must persist without becoming final",
    );
    for (const invalid of ["\0", "\ud800", "\udc00"]) {
      for (const kind of ["tool", "proposal"] as const) {
        await assert.rejects(
          f.sessions.recordEvent("local", project.projectId, active.turnId, {
            kind,
            payload: { nested: [{ text: invalid }] },
          }),
          status(400),
        );
        await assert.rejects(
          f.sessions.recordEvent("local", project.projectId, active.turnId, {
            kind,
            payload: { [invalid]: "invalid key" },
          }),
          status(400),
        );
      }
    }
    await f.sessions.recordEvent("local", project.projectId, active.turnId, {
      kind: "tool",
      payload: { name: "save_file", state: "proposed" },
    });
    await f.sessions.recordEvent("local", project.projectId, active.turnId, {
      kind: "proposal",
      payload: { apply: false },
    });
    const initial = await f.sessions.turn(
      "local",
      project.projectId,
      active.turnId,
    );
    assert.equal(initial.state, "running");
    assert.equal(initial.response, "partial\n\nevent: completed");
    const response = await f.sessions.events(
      "local",
      project.projectId,
      active.turnId,
    );
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const reader = response.body!.getReader();
    assert.equal((await frame(reader)).data.completed, false);
    for (const kind of ["partial", "tool", "proposal"]) {
      const received = await frame(reader);
      assert.equal(received.event, kind);
      assert.equal(received.data.completed, false);
    }
    await f.operations.finish("local", active.jobId, "completed");
    assert.equal((await frame(reader)).event, "completed");
    assert.equal((await reader.read()).done, true);
    assert.equal(
      (await f.sessions.turn("local", project.projectId, active.turnId)).state,
      "completed",
    );
    await assert.rejects(
      f.sessions.recordEvent("local", project.projectId, active.turnId, {
        kind: "partial",
        text: "late",
      }),
      status(409),
    );
    const resumed = (
      await f.sessions.events("local", project.projectId, active.turnId, {
        after: 3,
      })
    ).body!.getReader();
    await frame(resumed);
    assert.equal((await frame(resumed)).event, "completed");
    assert.equal((await resumed.read()).done, true);
    const middle = (
      await f.sessions.events("local", project.projectId, active.turnId, {
        after: 1,
      })
    ).body!.getReader();
    await frame(middle);
    assert.equal((await frame(middle)).event, "tool");
    assert.equal((await frame(middle)).event, "proposal");
    assert.equal((await frame(middle)).event, "completed");
    assert.equal((await middle.read()).done, true);
    await assert.rejects(
      f.sessions.events("local", project.projectId, active.turnId, {
        after: 4,
      }),
      status(409),
    );
    for (const eventFirst of [true, false]) {
      const race = await f.seedTurn(project);
      const emit = () =>
        f.sessions.recordEvent("local", project.projectId, race.turnId, {
          kind: "partial",
          text: "serialized",
        });
      const complete = () =>
        f.operations.finish("local", race.jobId, "completed");
      const outcomes = await Promise.allSettled(
        eventFirst ? [emit(), complete()] : [complete(), emit()],
      );
      assert.equal(outcomes[0].status, "fulfilled");
      assert.equal(outcomes[1].status, eventFirst ? "fulfilled" : "rejected");
      const projection = await f.sessions.turn(
        "local",
        project.projectId,
        race.turnId,
      );
      assert.equal(projection.response, eventFirst ? "serialized" : "");
      assert.equal(projection.state, "completed");
    }
    await assert.rejects(
      f.sessions.turn("other", project.projectId, active.turnId),
      status(404),
    );
    const unrelated = await f.seed();
    await assert.rejects(
      f.sessions.events("local", unrelated.projectId, active.turnId),
      status(404),
    );

    const failed = await f.seedTurn(project);
    await f.sessions.recordEvent("local", project.projectId, failed.turnId, {
      kind: "partial",
      text: "not complete",
    });
    await f.operations.finish("local", failed.jobId, "failed");
    const failedWire = await (
      await f.sessions.events("local", project.projectId, failed.turnId)
    ).text();
    assert.match(failedWire, /event: failed/);
    assert.doesNotMatch(failedWire, /event: completed\n/);
    assert.doesNotMatch(failedWire, /"completed":true/);

    const cancelled = await f.seedTurn(project);
    await f.sessions.recordEvent("local", project.projectId, cancelled.turnId, {
      kind: "partial",
      text: "visible progress",
    });
    const disconnected = (
      await f.sessions.events("local", project.projectId, cancelled.turnId)
    ).body!.getReader();
    await frame(disconnected);
    await disconnected.cancel();
    assert.equal(
      (await f.operations.get("local", cancelled.jobId)).state,
      "running",
      "disconnect is not completion or cancellation",
    );
    const abort = new AbortController();
    const abortReader = (
      await f.sessions.events("local", project.projectId, cancelled.turnId, {
        after: 1,
        signal: abort.signal,
      })
    ).body!.getReader();
    await frame(abortReader);
    const waiting = abortReader.read();
    abort.abort();
    assert.equal((await waiting).done, true);
    assert.equal(
      (await f.operations.get("local", cancelled.jobId)).state,
      "running",
    );
    const owned = await testContainer(f.credentials, cancelled.jobId);
    f.cleanup.push(() => removeOwned(owned));
    await f.operations.registerContainer("local", cancelled.jobId, owned);
    await f.operations.requestCancel("local", cancelled.jobId);
    await f.operations.finish("local", cancelled.jobId, "cancelled");
    const cancelledWire = await (
      await f.sessions.events("local", project.projectId, cancelled.turnId)
    ).text();
    assert.match(cancelledWire, /event: cancelled/);
    assert.doesNotMatch(cancelledWire, /event: completed\n/);
    assert.doesNotMatch(cancelledWire, /"completed":true/);

    const bounded = await f.seedTurn(project);
    const overhead = Buffer.byteLength(
      JSON.stringify({ kind: "partial", text: "" }),
    );
    const exact = "a".repeat(65536 - overhead);
    await f.sessions.recordEvent("local", project.projectId, bounded.turnId, {
      kind: "partial",
      text: exact,
    });
    await assert.rejects(
      f.sessions.recordEvent("local", project.projectId, bounded.turnId, {
        kind: "partial",
        text: exact + "a",
      }),
      status(413),
    );
    for (let i = 1; i < 32; i++)
      await f.sessions.recordEvent("local", project.projectId, bounded.turnId, {
        kind: "partial",
        text: exact,
      });
    await assert.rejects(
      f.sessions.recordEvent("local", project.projectId, bounded.turnId, {
        kind: "tool",
        payload: null,
      }),
      status(413),
    );
    assert.equal(
      (await f.sessions.turn("local", project.projectId, bounded.turnId))
        .lastSequence,
      32,
    );
    const counted = await f.seedTurn(project);
    for (let i = 0; i < 256; i++)
      await f.sessions.recordEvent("local", project.projectId, counted.turnId, {
        kind: "tool",
        payload: null,
      });
    await assert.rejects(
      f.sessions.recordEvent("local", project.projectId, counted.turnId, {
        kind: "tool",
        payload: null,
      }),
      status(413),
    );
    const queuedJob = await f.operations.admit({
      actor: "local",
      requestId: randomUUID(),
      purpose: "chat",
      fingerprint: hash("new prompt"),
      grantId: await f.operations.grant("local", "chat", hash("new prompt")),
    });
    const turnId = await f.sessions.openTurn(
      "local",
      project.projectId,
      queuedJob.id,
      "new prompt",
    );
    assert.equal(
      await f.sessions.openTurn(
        "local",
        project.projectId,
        queuedJob.id,
        "new prompt",
      ),
      turnId,
    );
    await assert.rejects(
      f.sessions.openTurn(
        "local",
        unrelated.projectId,
        queuedJob.id,
        "new prompt",
      ),
      status(409),
    );
    await assert.rejects(
      f.sessions.openTurn(
        "local",
        project.projectId,
        queuedJob.id,
        "changed prompt",
      ),
      status(409),
    );
    await f.operations.dispatch("local", queuedJob.id);
    await f.sessions.recordEvent("local", project.projectId, turnId, {
      kind: "partial",
      text: "interrupted",
    });
    await f.operations.close();
    const next = new Operations(f.state, f.credentials);
    f.cleanup.push(() => next.close());
    await next.acquire();
    const interruptedWire = await (
      await f.sessions.events("local", project.projectId, turnId)
    ).text();
    assert.match(interruptedWire, /event: interrupted/);
    assert.doesNotMatch(interruptedWire, /event: completed\n/);
    assert.doesNotMatch(interruptedWire, /"completed":true/);
  },
);
/** @id TEST-SESSION-003 @verifies REQ-SESSION-003 */
test(
  "TEST-SESSION-003 bounded history and approved excerpts; no ambient file disclosure",
  { timeout: 120000 },
  async (t) => {
    const selectedId = randomUUID(),
      secretId = randomUUID(),
      foreignId = randomUUID();
    const scope = { projectId: "", actor: "local" };
    const calls: string[] = [];
    let selectedText = "explicitly selected fragment";
    const resolver: ExcerptResolver = async (selection) => {
      calls.push(selection.sourceId);
      assert.notEqual(
        selection.sourceId,
        secretId,
        "ambient research files must never be resolved",
      );
      return {
        ...selection,
        actor: selection.sourceId === foreignId ? "foreign" : scope.actor,
        projectId: scope.projectId,
        text: selectedText,
      };
    };
    const f = await fixture(t, resolver);
    const project = await f.seed();
    scope.projectId = project.projectId;
    scope.actor = project.actor;
    const foreign = await f.seed("another");
    await f.seedTurn(
      foreign,
      "foreign question",
      "FORBIDDEN_FOREIGN_TEXT",
      "completed",
    );
    for (let i = 0; i < 5; i++)
      await f.seedTurn(
        project,
        "p".repeat(1000),
        `${i}`.repeat(6000),
        "completed",
      );
    await f.seedTurn(project, "pending question", "UNFINISHED_SECRET");
    await f.seedTurn(project, "failed question", "FAILED_SECRET", "failed");
    let history!: Awaited<ReturnType<Sessions["history"]>>;
    await assert.doesNotReject(async () => {
      history = await f.sessions.history("local", project.projectId);
    }, "bounded complete history must resolve without ambient data");
    assert.equal(history.turns.length, 4);
    assert.equal(history.omittedComplete, 1);
    assert.equal(history.omittedIncomplete, 2);
    assert.deepEqual(
      history.turns.map((turn) => turn.response[0]),
      ["1", "2", "3", "4"],
    );
    assert.equal(
      history.turns.reduce(
        (sum, turn) => sum + [...(turn.prompt + turn.response)].length,
        0,
      ),
      28000,
    );
    const emptySelection = await f.sessions.previewContext(
      "local",
      project.projectId,
      "new question",
    );
    assert.deepEqual(calls, []);
    assert.doesNotMatch(
      emptySelection.wire,
      /FORBIDDEN_FOREIGN|UNFINISHED_SECRET|FAILED_SECRET/,
    );
    assert.deepEqual(JSON.parse(emptySelection.wire).omissions, {
      complete: 1,
      incomplete: 2,
    });
    const selection: ExcerptSelection = {
      kind: "file",
      sourceId: selectedId,
      start: 5,
      end: 100,
    };
    const preview = await f.sessions.previewContext(
      "local",
      project.projectId,
      "new question",
      [selection, selection],
    );
    assert.equal(preview.excerpts.length, 1);
    assert.deepEqual(calls, [selectedId]);
    assert.equal(preview.excerpts[0].text, selectedText);
    assert.equal(preview.fingerprint.length, 64);
    const grantId = await f.operations.grant(
      "local",
      "chat",
      preview.fingerprint,
    );
    const authorized = await f.sessions.authorizedContext(
      "local",
      project.projectId,
      "new question",
      [selection],
      grantId,
    );
    assert.equal(authorized.wire, preview.wire);
    await assert.rejects(
      f.sessions.authorizedContext(
        "local",
        project.projectId,
        "changed question",
        [selection],
        grantId,
      ),
      status(409),
    );
    await assert.rejects(
      f.sessions.authorizedContext(
        "local",
        project.projectId,
        "new question",
        [],
        grantId,
      ),
      status(409),
    );
    await assert.rejects(
      f.sessions.previewContext("local", project.projectId, "question", [
        { ...selection, sourceId: foreignId },
      ]),
      status(404),
    );
    await assert.rejects(
      f.sessions.previewContext("foreign", project.projectId, "question", [
        selection,
      ]),
      status(404),
    );
    selectedText = "é".repeat(16384);
    assert.equal(
      Buffer.byteLength(
        (
          await f.sessions.previewContext("local", project.projectId, "q", [
            selection,
          ])
        ).excerpts[0].text,
      ),
      32768,
    );
    selectedText += "a";
    await assert.rejects(
      f.sessions.previewContext("local", project.projectId, "q", [selection]),
      status(413),
    );
    selectedText = "changed fragment";
    await assert.rejects(
      f.sessions.authorizedContext(
        "local",
        project.projectId,
        "new question",
        [selection],
        grantId,
      ),
      status(409),
    );
    await f.sessions.previewContext(
      "local",
      project.projectId,
      "🧪".repeat(16000),
    );
    await assert.rejects(
      f.sessions.previewContext("local", project.projectId, "x".repeat(16001)),
      status(400),
    );
    await f.seedTurn(project, "p", "n".repeat(31999), "completed");
    assert.equal(
      (await f.sessions.history("local", project.projectId)).turns.length,
      1,
    );
    await f.seedTurn(project, "p", "n".repeat(32000), "completed");
    const oversized = await f.sessions.history("local", project.projectId);
    assert.equal(
      oversized.turns.length,
      0,
      "an oversized newest turn must not skip into older unrelated context",
    );
    assert.equal(oversized.omittedComplete, 7);
    await f.admin.query("UPDATE projects SET status='archived' WHERE id=$1", [
      project.projectId,
    ]);
    await assert.rejects(
      f.sessions.previewContext("local", project.projectId, "no new turn"),
      status(409),
    );
    assert.equal(
      (await f.sessions.history("local", project.projectId)).omittedIncomplete,
      2,
    );
  },
);
