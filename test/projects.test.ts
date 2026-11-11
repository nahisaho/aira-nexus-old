import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { testDatabase } from "./helpers/database";
import { connectDatabase } from "../src/server/database";
import { Operations, type Purpose } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { Projects } from "../src/server/projects";
import { projectRoutes } from "../src/server/project-routes";
import { readJson } from "../src/server/local-boundary";
import { ServiceError } from "../src/server/http";
import { lanAddress } from "./helpers/nginx";

const status = (expected: number) => (error: unknown) =>
  error instanceof ServiceError && error.status === expected;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const origin = "http://localhost:43111";
function request(
  path = "/api/projects",
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(origin + path, {
    method,
    headers: {
      Host: "localhost:43111",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function fixture(t: TestContext) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const action of cleanup.reverse()) await action();
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
  const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
  cleanup.push(() => admin.end());
  const route = projectRoutes(projects);
  const seed = (actor = "local") =>
    sessions.createProject(actor, `fixture-${randomUUID()}`);
  async function intent(actor = "local", purpose: Purpose = "chat") {
    const fingerprint = hash(randomUUID());
    return {
      purpose,
      fingerprint,
      requestId: randomUUID(),
      grantId: await operations.grant(actor, purpose, fingerprint),
    };
  }
  return { ...db, operations, sessions, projects, admin, route, seed, intent };
}

/** @id TEST-PROJECT-001 @verifies REQ-PROJECT-001 */
test(
  "TEST-PROJECT-001 owned Unicode project fields persist and retain their mandatory chat",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    let created: Awaited<ReturnType<Projects["create"]>> | undefined;
    await assert.doesNotReject(async () => {
      created = await f.projects.create("local", {
        name: "  科学 🧪  ",
        description: "line1\nline2",
      });
    });
    assert.ok(created);
    assert.equal(created.name, "科学 🧪");
    assert.equal(created.description, "line1\nline2");
    assert.equal(created.revision, 1);
    assert.equal(created.actor, "local");
    assert.equal(created.chatTitle, "チャット");
    const edited = await f.projects.edit("local", created.id, {
      revision: 1,
      name: "😀".repeat(120),
      description: "あ".repeat(2000),
    });
    assert.equal(edited.revision, 2);
    assert.equal(edited.chatId, created.chatId);
    const reloaded = new Projects(
      f.operations,
      f.sessions,
      f.state,
      f.credentials,
    );
    try {
      assert.deepEqual(await reloaded.get("local", created.id), edited);
    } finally {
      await reloaded.close();
    }
    await f.seed("other");
    assert.deepEqual(
      (await f.projects.list("local")).map((p) => p.id),
      [created.id],
    );
    for (const input of [
      { name: "" },
      { name: " \t " },
      { name: "😀".repeat(121) },
      { name: "x", description: "あ".repeat(2001) },
      { name: 7 },
      { name: "x", actor: "other" },
      { name: "x\0" },
      { name: "\uD800" },
      { name: "x", description: "\uDC00" },
    ])
      await assert.rejects(f.projects.create("local", input), status(400));
    await assert.rejects(
      f.projects.edit("local", created.id, { revision: 2, name: "" }),
      status(400),
    );
    await assert.rejects(
      f.projects.edit("local", created.id, { revision: 2 }),
      status(400),
    );
    const descriptionOnly = await f.projects.edit("local", created.id, {
      revision: 2,
      description: "",
    });
    assert.equal(descriptionOnly.name, edited.name);
    assert.equal(descriptionOnly.description, "");
    const response = await f.route(
      request("/api/projects", "POST", { name: "HTTP project" }),
    );
    assert.equal(response.status, 201);
    const webProject = await response.json();
    assert.equal(webProject.actor, "local");
    const patch = await f.route(
      request(`/api/projects/${webProject.id}`, "PATCH", {
        revision: 1,
        name: " HTTP edit ",
      }),
    );
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).name, "HTTP edit");
    assert.equal(
      (await (await f.route(request(`/api/projects/${webProject.id}`))).json())
        .revision,
      2,
    );
  },
);

/** @id TEST-PROJECT-006 @verifies REQ-PROJECT-006 */
test(
  "TEST-PROJECT-006 project pins and recent visits persist without changing research revisions",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.seed(),
      second = await f.seed(),
      third = await f.seed();
    await f.admin.query(
      `UPDATE projects SET created_at=CASE WHEN id=$1 THEN $2::timestamptz
       ELSE $3::timestamptz END WHERE id=ANY($4::uuid[])`,
      [
        third.id,
        "2026-01-02T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        [first.id, second.id, third.id],
      ],
    );
    assert.deepEqual(
      (await f.projects.list("local")).map((project) => project.id),
      [third.id, ...[first.id, second.id].sort()],
      "unopened projects use descending creation time and ascending ID ties",
    );
    assert.equal(first.pinned, false);
    assert.equal(first.lastOpenedAt, null);
    const pin = await f.route(
      request(`/api/projects/${first.id}/pin`, "POST", { pinned: true }),
    );
    assert.equal(pin.status, 200);
    assert.equal((await pin.json()).pinned, true);
    for (const project of [first, second]) {
      const visit = await f.route(
        request(`/api/projects/${project.id}/visit`, "POST", {}),
      );
      assert.equal(visit.status, 200);
      assert.ok((await visit.json()).lastOpenedAt);
    }
    assert.deepEqual(
      (await f.projects.list("local")).map((p) => p.id),
      [second.id, first.id, third.id],
    );
    assert.equal(
      (await f.projects.get("local", first.id)).revision,
      first.revision,
    );
    const archived = await f.projects.archive(
      "local",
      first.id,
      first.revision,
    );
    assert.equal(
      (await f.projects.pin("local", first.id, { pinned: false })).pinned,
      false,
    );
    await f.projects.visit("local", first.id, {});
    await f.projects.pin("local", second.id, { pinned: true });
    const reloaded = new Projects(
      f.operations,
      f.sessions,
      f.state,
      f.credentials,
    );
    try {
      const project = await reloaded.get("local", first.id);
      assert.equal(project.pinned, false);
      assert.equal(project.revision, archived.revision);
      assert.equal(project.status, "archived");
      assert.equal(project.chatId, first.chatId);
      assert.ok(project.lastOpenedAt);
      assert.equal((await reloaded.list("local"))[0].id, first.id);
      assert.equal((await reloaded.get("local", second.id)).pinned, true);
      assert.equal(
        (await reloaded.get("local", second.id)).lastOpenedAt,
        (await f.projects.get("local", second.id)).lastOpenedAt,
      );
    } finally {
      await reloaded.close();
    }
  },
);
/** @id TEST-PROJECT-007 @verifies REQ-PROJECT-006 */
test(
  "TEST-PROJECT-007 project navigation rejects invalid inputs and foreign or hidden projects",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t),
      own = await f.seed(),
      foreign = await f.seed("other");
    for (const body of [
      {},
      { pinned: "true" },
      { pinned: true, actor: "other" },
    ])
      assert.equal(
        (await f.route(request(`/api/projects/${own.id}/pin`, "POST", body)))
          .status,
        400,
      );
    assert.equal(
      (
        await f.route(
          request(`/api/projects/${own.id}/visit`, "POST", {
            lastOpenedAt: "2099-01-01",
          }),
        )
      ).status,
      400,
    );
    for (const id of ["bad", randomUUID(), foreign.id]) {
      for (const [suffix, body] of [
        ["pin", { pinned: true }],
        ["visit", {}],
      ] as const) {
        assert.equal(
          (
            await f.route(
              request(`/api/projects/${id}/${suffix}`, "POST", body),
            )
          ).status,
          id === "bad" ? 400 : 404,
        );
      }
    }
    await f.projects.hide("local", own.id, own.revision);
    for (const [suffix, body] of [
      ["pin", { pinned: true }],
      ["visit", {}],
    ] as const) {
      assert.equal(
        (
          await f.route(
            request(`/api/projects/${own.id}/${suffix}`, "POST", body),
          )
        ).status,
        404,
      );
      assert.equal(
        (await f.route(request(`/api/projects/${foreign.id}/${suffix}`)))
          .status,
        405,
      );
    }
    assert.equal((await f.projects.deleted("local"))[0].pinned, false);
    assert.equal((await f.projects.deleted("local"))[0].lastOpenedAt, null);
    assert.equal((await f.projects.get("other", foreign.id)).pinned, false);
    assert.equal(
      (await f.projects.get("other", foreign.id)).lastOpenedAt,
      null,
    );
  },
);

/** @id TEST-PROJECT-002 @verifies REQ-PROJECT-002 */
test(
  "TEST-PROJECT-002 archive retains project/chat/history and refuses later effects",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t),
      p = await f.seed();
    await f.sessions.rename("local", p.id, "retained title");
    let archived: Awaited<ReturnType<Projects["archive"]>> | undefined;
    await assert.doesNotReject(async () => {
      archived = await f.projects.archive("local", p.id, p.revision);
    });
    assert.ok(archived);
    assert.equal(archived.status, "archived");
    assert.equal(archived.revision, 2);
    const read = await f.projects.get("local", p.id);
    assert.equal(read.chatId, p.chatId);
    assert.equal(read.chatTitle, "retained title");
    assert.equal((await f.projects.list("local"))[0].status, "archived");
    await assert.rejects(
      f.projects.edit("local", p.id, { revision: 2, name: "forbidden" }),
      status(409),
    );
    await assert.rejects(f.projects.archive("local", p.id, 2), status(409));
    await assert.rejects(
      f.sessions.rename("local", p.id, "forbidden"),
      status(409),
    );
    const input = await f.intent();
    await assert.rejects(f.projects.admit("local", p.id, input), status(409));
    const unscoped = await f.operations.admit({
      actor: "local",
      ...(await f.intent()),
    });
    await assert.rejects(
      f.sessions.openTurn("local", p.id, unscoped.id, "forbidden"),
      status(409),
    );
    assert.equal(
      (
        await f.admin.query("SELECT consumed_by FROM grants WHERE id=$1", [
          input.grantId,
        ])
      ).rows[0].consumed_by,
      null,
    );
    assert.equal(
      (await f.route(request(`/api/projects/${p.id}`, "DELETE"))).status,
      405,
    );
    assert.equal(
      (
        await f.route(
          request(`/api/projects/${p.id}`, "PATCH", {
            revision: 2,
            status: "active",
          }),
        )
      ).status,
      400,
    );
    assert.deepEqual(await f.projects.get("local", p.id), read);
    assert.equal(
      (
        await f.admin.query(
          "SELECT count(*)::int AS n FROM chats WHERE project_id=$1",
          [p.id],
        )
      ).rows[0].n,
      1,
    );
  },
);

/** @id TEST-PROJECT-003 @verifies REQ-PROJECT-003 */
test(
  "TEST-PROJECT-003 malformed400 and unknown/foreign404 across owned repository and routes",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t),
      own = await f.seed(),
      foreign = await f.seed("other");
    const scoped = await f.projects.admit("local", own.id, await f.intent());
    await assert.rejects(
      f.admin.query("UPDATE jobs SET project_id=$1 WHERE id=$2", [
        foreign.id,
        scoped.id,
      ]),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "23503",
    );
    assert.equal(
      (await f.operations.get("local", scoped.id)).project_id,
      own.id,
    );
    assert.equal(
      (await f.route(request(`/api/projects/${own.id}/archive`, "POST", {})))
        .status,
      400,
    );
    for (const id of ["bad", "", "1 OR 1=1", "\uD800"])
      await assert.rejects(f.projects.get("local", id), status(400));
    for (const id of [randomUUID(), foreign.id]) {
      await assert.rejects(f.projects.get("local", id), status(404));
      await assert.rejects(
        f.projects.edit("local", id, { revision: 1, name: "hidden" }),
        status(404),
      );
      await assert.rejects(f.projects.archive("local", id, 1), status(404));
      await assert.rejects(
        f.projects.admit("local", id, await f.intent()),
        status(404),
      );
      for (const [method, suffix, body] of [
        ["GET", "", undefined],
        ["PATCH", "", { revision: 1, name: "hidden" }],
        ["POST", "/archive", { revision: 1 }],
      ] as const) {
        const response = await f.route(
          request(`/api/projects/${id}${suffix}`, method, body),
        );
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { code: "PROJECT_NOT_FOUND" });
      }
    }
    assert.equal(
      (await f.route(request("/api/projects/not-a-uuid"))).status,
      400,
    );
    assert.equal(
      (await f.route(request("/api/projects/%E0%A4%A"))).status,
      400,
    );
    assert.equal(
      (await f.route(request(`/api/projects/${foreign.id}?actor=other`)))
        .status,
      404,
    );
    assert.equal(
      (
        await f.route(
          request("/api/projects", "POST", { name: "x", actor: "other" }),
        )
      ).status,
      400,
    );
    const listed = await (await f.route(request())).json();
    assert.deepEqual(
      listed.projects.map((p: { id: string }) => p.id),
      [own.id],
    );
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(foreign.id));
  },
);

/** @id TEST-PROJECT-004 @verifies REQ-PROJECT-004 */
test(
  "TEST-PROJECT-004 exact loopback/public Host/Origin, bounded UTF8 body, deny framing and no CORS",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const valid = await f.route(request());
    assert.equal(valid.status, 200);
    const address = lanAddress();
    const publicHost = `${address}:43111`;
    const publicUrl = `http://${publicHost}`;
    const previousPublic = process.env.AIRA_PUBLIC_ORIGIN;
    delete process.env.AIRA_PUBLIC_ORIGIN;
    try {
      assert.equal(
        (
          await f.route(
            request("/api/projects", "GET", undefined, { Host: publicHost }),
          )
        ).status,
        403,
      );
      process.env.AIRA_PUBLIC_ORIGIN = publicUrl;
      for (const supplied of [undefined, publicUrl]) {
        const response = await f.route(
          request("/api/projects", "GET", undefined, {
            Host: publicHost,
            ...(supplied ? { Origin: supplied } : {}),
          }),
        );
        assert.equal(
          response.status,
          200,
          "explicit public origin must accept same/absent Origin",
        );
        assert.equal(response.headers.get("X-Frame-Options"), "DENY");
        assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
      }
      for (const supplied of [
        "http://evil.test",
        origin,
        `https://${publicHost}`,
        `http://${address}:43112`,
        `${publicUrl}/`,
        "null",
      ]) {
        assert.equal(
          (
            await f.route(
              request("/api/projects", "GET", undefined, {
                Host: publicHost,
                Origin: supplied,
                "X-Forwarded-Proto": "https",
              }),
            )
          ).status,
          403,
          supplied,
        );
      }
      for (const Host of [
        `${address}:43112`,
        `${address}:65536`,
        "evil.test",
      ]) {
        assert.equal(
          (
            await f.route(
              request("/api/projects", "GET", undefined, {
                Host,
                "X-Forwarded-Host": publicHost,
              }),
            )
          ).status,
          403,
        );
      }
      assert.equal(
        (
          await f.route(
            request("/api/projects", "GET", undefined, {
              Host: publicHost,
              "Content-Length": String(12 * 1024 * 1024 + 1),
            }),
          )
        ).status,
        413,
      );
    } finally {
      if (previousPublic === undefined) delete process.env.AIRA_PUBLIC_ORIGIN;
      else process.env.AIRA_PUBLIC_ORIGIN = previousPublic;
    }
    for (const [host, suppliedOrigin] of [
      ["localhost:43111", origin],
      ["127.0.0.1:43111", "http://127.0.0.1:43111"],
      ["[::1]:43111", "http://[::1]:43111"],
      ["localhost:80", "http://localhost"],
      ["LOCALHOST:43111", origin],
    ])
      assert.equal(
        (
          await f.route(
            request("/api/projects", "GET", undefined, {
              Host: host,
              Origin: suppliedOrigin,
            }),
          )
        ).status,
        200,
      );
    for (const Host of [
      "",
      "evil.test",
      "localhost.evil.test",
      "127.1",
      "2130706433",
      "127.0.0.2",
      "[::ffff:127.0.0.1]",
      "localhost:65536",
      "localhost:43111,evil.test",
      "user@localhost",
    ]) {
      assert.equal(
        (
          await f.route(
            request("/api/projects", "GET", undefined, {
              Host,
              "X-Forwarded-Host": "localhost:43111",
            }),
          )
        ).status,
        403,
        Host,
      );
    }
    const missingHost = request();
    missingHost.headers.delete("Host");
    assert.equal((await f.route(missingHost)).status, 403);
    for (const Origin of [
      "null",
      "https://localhost:43111",
      "http://evil.test",
      "http://127.0.0.1:43111",
      "http://localhost:43112",
      `${origin}/path`,
      `${origin}/`,
      `http://user@localhost:43111`,
      `${origin},http://evil.test`,
    ]) {
      assert.equal(
        (
          await f.route(
            request("/api/projects", "POST", { name: "blocked" }, { Origin }),
          )
        ).status,
        403,
        Origin,
      );
    }
    assert.equal(
      (await f.route(request("/api/projects", "OPTIONS"))).status,
      405,
    );
    const denied = await f.route(
      request("/api/projects", "GET", undefined, { Host: "evil.test" }),
    );
    for (const response of [valid, denied]) {
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(
        response.headers.get("Cross-Origin-Resource-Policy"),
        "same-origin",
      );
      assert.equal(response.headers.get("X-Frame-Options"), "DENY");
      assert.match(
        response.headers.get("Content-Security-Policy") ?? "",
        /frame-ancestors 'none'/,
      );
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    }
    const limit = 12 * 1024 * 1024;
    const exact = '"' + "あ" + "x".repeat(limit - 5) + '"';
    assert.equal(Buffer.byteLength(exact), limit);
    assert.equal(
      await readJson(
        new Request(origin, {
          method: "POST",
          body: exact,
          headers: { "Content-Type": "application/json" },
        }),
      ),
      JSON.parse(exact),
    );
    assert.equal(
      (
        await f.route(
          request(
            "/api/projects",
            "POST",
            { name: "never read" },
            { "Content-Length": String(limit + 1) },
          ),
        )
      ).status,
      413,
    );
    let sent = 0,
      cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent === limit / (64 * 1024) + 1) {
            controller.close();
            return;
          }
          sent++;
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const init = {
      method: "POST",
      headers: {
        Host: "localhost:43111",
        "Content-Type": "application/json",
        "Content-Length": "1",
      },
      body: stream,
      duplex: "half",
    };
    assert.equal(
      (await f.route(new Request(origin + "/api/projects", init))).status,
      413,
    );
    assert.equal(cancelled, true);
    assert.equal(
      sent,
      limit / (64 * 1024) + 1,
      "bounded read stops at first oversized chunk despite advertised smaller length",
    );
    for (const length of ["-1", "1.5", "1, 2", "garbage"]) {
      assert.equal(
        (
          await f.route(
            request("/api/projects", "POST", {}, { "Content-Length": length }),
          )
        ).status,
        400,
      );
    }
    const badJson = new Request(origin + "/api/projects", {
      method: "POST",
      headers: { Host: "localhost:43111", "Content-Type": "application/json" },
      body: "{",
    });
    assert.equal((await f.route(badJson)).status, 400);
    const invalidUtf8 = new Request(origin, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new Uint8Array([0x22, 0xff, 0x22]),
    });
    await assert.rejects(readJson(invalidUtf8), status(400));
    assert.equal(
      (
        await f.route(
          request(
            "/api/projects",
            "POST",
            { name: "x" },
            { "Content-Type": "text/plain" },
          ),
        )
      ).status,
      415,
    );
    assert.equal(
      (await f.admin.query("SELECT count(*)::int AS n FROM projects")).rows[0]
        .n,
      0,
      "boundary refuses before any write",
    );
  },
);

/** @id TEST-PROJECT-005 @verifies REQ-PROJECT-005 */
test(
  "TEST-PROJECT-005 stale revisions and both archive/admission orders for chat and execution",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t),
      editedProject = await f.seed();
    await assert.rejects(
      f.projects.edit("local", editedProject.id, { revision: 0, name: "bad" }),
      status(400),
    );
    await assert.rejects(
      f.projects.edit("local", editedProject.id, {
        revision: 2,
        name: "stale",
      }),
      status(409),
    );
    assert.equal(
      (await f.projects.get("local", editedProject.id)).name,
      editedProject.name,
    );
    const edits = await Promise.allSettled([
      f.projects.edit("local", editedProject.id, {
        revision: 1,
        name: "first",
      }),
      f.projects.edit("local", editedProject.id, {
        revision: 1,
        name: "second",
      }),
    ]);
    assert.equal(edits[0].status, "fulfilled");
    assert.equal(edits[1].status, "rejected");
    assert.ok(edits[1].status === "rejected" && status(409)(edits[1].reason));
    assert.equal(
      (await f.projects.get("local", editedProject.id)).name,
      "first",
    );
    await assert.rejects(
      f.projects.archive("local", editedProject.id, 1),
      status(409),
    );
    for (const purpose of ["chat", "execution"] as const)
      for (const archiveFirst of [true, false]) {
        const p = await f.seed(),
          input = await f.intent("local", purpose);
        const archive = () => f.projects.archive("local", p.id, 1);
        const admit = () => f.projects.admit("local", p.id, input);
        const outcomes = await Promise.allSettled(
          archiveFirst ? [archive(), admit()] : [admit(), archive()],
        );
        assert.equal(outcomes[0].status, "fulfilled");
        assert.equal(outcomes[1].status, "rejected");
        assert.ok(
          outcomes[1].status === "rejected" && status(409)(outcomes[1].reason),
        );
        const scope = (
          await f.admin.query("SELECT id,state FROM jobs WHERE project_id=$1", [
            p.id,
          ])
        ).rows;
        const row = await f.projects.get("local", p.id);
        if (archiveFirst) {
          assert.equal(row.status, "archived");
          assert.equal(row.revision, 2);
          assert.equal(scope.length, 0);
          assert.equal(
            (
              await f.admin.query(
                "SELECT consumed_by FROM grants WHERE id=$1",
                [input.grantId],
              )
            ).rows[0].consumed_by,
            null,
          );
        } else {
          assert.equal(row.status, "active");
          assert.equal(row.revision, 1);
          assert.equal(scope.length, 1);
          await f.operations.dispatch("local", scope[0].id);
          await assert.rejects(
            f.projects.archive("local", p.id, 1),
            status(409),
          );
          await f.operations.finish("local", scope[0].id, "failed");
          const archived = await f.projects.archive("local", p.id, 1);
          assert.equal(archived.status, "archived");
          assert.equal(
            (await f.projects.admit("local", p.id, input)).id,
            scope[0].id,
            "terminal receipt retry after archive is not new admission",
          );
          const other = await f.seed();
          await assert.rejects(
            f.projects.admit("local", other.id, input),
            status(409),
          );
        }
      }
    const legacy = await f.seed(),
      other = await f.seed();
    const job = await f.operations.admit({
      actor: "local",
      ...(await f.intent()),
    });
    await f.sessions.openTurn("local", legacy.id, job.id, "scoped by turn");
    await assert.rejects(
      f.projects.archive("local", legacy.id, 1),
      status(409),
    );
    await assert.rejects(
      f.sessions.openTurn("local", other.id, job.id, "cannot move"),
      status(409),
    );
    const input = await f.intent();
    const scoped = await f.projects.admit("local", other.id, input);
    await assert.rejects(
      f.sessions.openTurn("local", legacy.id, scoped.id, "cannot rebind job"),
      status(409),
    );
    const free = await f.seed();
    assert.equal(
      (await f.projects.archive("local", free.id, 1)).status,
      "archived",
      "unrelated active work does not block archive",
    );
    assert.equal(
      (
        await f.route(
          request(`/api/projects/${editedProject.id}`, "PATCH", {
            revision: 1,
            name: "stale HTTP",
          }),
        )
      ).status,
      409,
    );
  },
);
