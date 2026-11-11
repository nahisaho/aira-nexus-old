import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  IntegrationCatalog,
  type IntegrationRegistry,
  type IntegrationSettings,
  type IntegrationSelections,
} from "../src/server/integration-catalog";
import { integrationRoutes } from "../src/server/integration-routes";
import { settingsFixture, settingsRequest } from "./helpers/project-settings";
import { ServiceError } from "../src/server/http";
import { Copilot } from "../src/server/copilot";
import { ControlledCopilot } from "./helpers/copilot";
import { createApplication } from "../src/server/application";
import { migrate } from "../scripts/migrate";
const empty: IntegrationSelections = { agents: [], skills: [], mcp: [] };
const selected: IntegrationSelections = {
  agents: [],
  skills: ["co-scientist-academic-writing"],
  mcp: ["tooluniverse"],
};
const status = (value: number) => (error: unknown) =>
  error instanceof ServiceError && error.status === value;
async function fixture(t: TestContext) {
  const f = await settingsFixture(t);
  const catalog = new IntegrationCatalog(f.operations, f.state, f.credentials);
  f.cleanup.push(() => catalog.close());
  return { ...f, catalog, catalogRoute: integrationRoutes(catalog) };
}
/** @id TEST-CAT-001 @verifies REQ-CAT-001 */
test(
  "TEST-CAT-001 exact pinned metadata catalog with empty Agents",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const response = await f.catalogRoute(settingsRequest("/api/integrations"));
    assert.equal(response.status, 200);
    const registry: IntegrationRegistry = await response.json();
    const { appliedToChat, ...metadata } = registry;
    assert.equal(appliedToChat, false);
    assert.deepEqual(registry.source, {
      repository: "nahisaho/aira",
      commit: "f59dd41972253c85f91b966c46cba4fbde9507e0",
      root: "skills/co-scientist",
    });
    assert.equal(registry.skills.length, 203);
    assert.equal(new Set(registry.skills.map((entry) => entry.id)).size, 203);
    assert.deepEqual(registry.agents, []);
    assert.deepEqual(
      registry.mcp.map((entry) => entry.id),
      ["tooluniverse"],
    );
    assert.equal(
      createHash("sha256")
        .update(JSON.stringify(metadata, null, 2) + "\n")
        .digest("hex"),
      "d6416a28d6ce29498c682fc9bf637814aa03ef0ee13d864d1c7fbbe1d1d0a5b4",
      "independently retained pinned upstream metadata digest, not a producer-derived expected result",
    );
    for (const entry of [...registry.skills, ...registry.mcp]) {
      assert.ok(entry.path.startsWith("skills/co-scientist/"));
      assert.match(entry.gitBlob, /^[a-f0-9]{40}$/);
      assert.ok(
        Object.keys(entry).every((key) =>
          ["id", "name", "path", "gitBlob", "reference"].includes(key),
        ),
      );
    }
    registry.skills[0].name = "client-only mutation";
    assert.notEqual(
      f.catalog.registry().skills[0].name,
      "client-only mutation",
    );
    assert.equal(
      (await f.catalogRoute(settingsRequest("/api/integrations", "POST", {})))
        .status,
      405,
    );
    const hostile = settingsRequest("/api/integrations");
    hostile.headers.set("Origin", "https://untrusted.invalid");
    assert.equal((await f.catalogRoute(hostile)).status, 403);
  },
);
/** @id TEST-CAT-002 @verifies REQ-CAT-002 */
test(
  "TEST-CAT-002 scoped revisioned selection persistence and visibility fences",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t),
      p = f.project;
    let initial!: IntegrationSettings;
    await assert.doesNotReject(async () => {
      initial = await f.catalog.get("local", p.id);
    });
    assert.deepEqual(initial, {
      revision: 1,
      selections: empty,
      appliedToChat: false,
    });
    const saved = await f.catalog.save("local", p.id, {
      revision: 1,
      selections: selected,
    });
    assert.deepEqual(saved, {
      revision: 2,
      selections: selected,
      appliedToChat: false,
    });
    assert.equal((await f.projects.get("local", p.id)).revision, p.revision);
    const otherClient = new IntegrationCatalog(
      f.operations,
      f.state,
      f.credentials,
    );
    f.cleanup.push(() => otherClient.close());
    await migrate(f.state, f.credentials);
    assert.deepEqual(await otherClient.get("local", p.id), saved);
    for (const input of [
      { revision: 2, selections: { ...empty, agents: ["invented-agent"] } },
      { revision: 2, selections: { ...empty, skills: ["unknown"] } },
      { revision: 2, selections: { ...empty, skills: ["tooluniverse"] } },
      {
        revision: 2,
        selections: {
          ...empty,
          skills: [...selected.skills, ...selected.skills],
        },
      },
      {
        revision: 2,
        selections: { ...empty, mcp: ["tooluniverse", "tooluniverse"] },
      },
      { revision: 2, selections: { ...empty, mcp: [...selected.skills] } },
      { revision: 0, selections: empty },
      { revision: 2, selections: { ...empty, credentials: "not-accepted" } },
      { revision: 2, selections: empty, command: "not-accepted" },
      { revision: 2, selections: empty, serverPath: "/synthetic-host-path" },
    ])
      await assert.rejects(f.catalog.save("local", p.id, input), status(400));
    assert.deepEqual(await otherClient.get("local", p.id), saved);
    await assert.rejects(
      f.catalog.save("local", p.id, { revision: 1, selections: empty }),
      status(409),
    );
    for (const id of [f.foreign.id, randomUUID()]) {
      await assert.rejects(f.catalog.get("local", id), status(404));
      await assert.rejects(
        f.catalog.save("local", id, { revision: 1, selections: empty }),
        status(404),
      );
      assert.equal(
        (
          await f.catalogRoute(
            settingsRequest(`/api/projects/${id}/integrations`),
          )
        ).status,
        404,
      );
    }
    await assert.rejects(f.catalog.get("local", "invalid"), status(400));
    const outcomes = await Promise.allSettled([
      f.catalog.save("local", p.id, { revision: 2, selections: empty }),
      otherClient.save("local", p.id, { revision: 2, selections: empty }),
    ]);
    assert.equal(
      outcomes.filter((value) => value.status === "fulfilled").length,
      1,
    );
    const rejected = outcomes.find((value) => value.status === "rejected");
    assert.ok(rejected?.status === "rejected" && status(409)(rejected.reason));
    assert.deepEqual(await f.catalog.get("local", p.id), {
      revision: 3,
      selections: empty,
      appliedToChat: false,
    });
    await f.catalog.save("local", p.id, { revision: 3, selections: selected });
    const hidden = await f.projects.hide("local", p.id, 1);
    await assert.rejects(f.catalog.get("local", p.id), status(404));
    assert.equal(
      (
        await f.catalogRoute(
          settingsRequest(`/api/projects/${p.id}/integrations`, "PUT", {
            revision: 4,
            selections: empty,
          }),
        )
      ).status,
      404,
    );
    const restored = await f.projects.restore("local", p.id, hidden.revision);
    assert.deepEqual(await otherClient.get("local", p.id), {
      revision: 4,
      selections: selected,
      appliedToChat: false,
    });
    await f.projects.archive("local", p.id, restored.revision);
    assert.equal((await f.catalog.get("local", p.id)).revision, 4);
    await assert.rejects(
      f.catalog.save("local", p.id, { revision: 4, selections: empty }),
      status(409),
    );
    const boundary = await f.projects.create("local", {
      name: "Settings revision boundary",
    });
    await f.admin.query(
      "INSERT INTO project_integration_settings(project_id,actor,revision,selections) VALUES($1,'local',2147483647,$2)",
      [boundary.id, JSON.stringify(selected)],
    );
    await assert.rejects(
      f.catalog.save("local", boundary.id, {
        revision: 2147483647,
        selections: empty,
      }),
      status(409),
    );
    await f.operations.close();
    await assert.rejects(
      f.catalog.save("local", p.id, { revision: 4, selections: empty }),
      status(503),
    );
  },
);
/** @id TEST-CAT-003 @verifies REQ-CAT-003 */
test(
  "TEST-CAT-003 saved selections never activate external SDK capabilities",
  { timeout: 180000 },
  async (t) => {
    const f = await fixture(t),
      p = f.project;
    await assert.doesNotReject(() =>
      f.catalog.save("local", p.id, { revision: 1, selections: selected }),
    );
    while (f.cleanup.length > 1) await f.cleanup.pop()!();
    const sdk = new ControlledCopilot();
    let network = 0;
    t.mock.method(globalThis, "fetch", async () => {
      network++;
      throw new Error("CATALOG_UNEXPECTED_NETWORK");
    });
    await assert.rejects(
      () => fetch("https://synthetic.invalid/spy-control"),
      /CATALOG_UNEXPECTED_NETWORK/,
    );
    assert.equal(network, 1);
    network = 0;
    const app = await createApplication({
      state: f.state,
      auth: async () => ({ isAuthenticated: true }),
      copilot: new Copilot({
        executable: process.execPath,
        state: f.state,
        runtimeFactory: sdk.factory,
      }),
    });
    f.cleanup.push(() => app.close());
    assert.equal(
      (await app.handle(settingsRequest("/api/integrations"))).status,
      200,
    );
    const saved: IntegrationSettings = await (
      await app.handle(settingsRequest(`/api/projects/${p.id}/integrations`))
    ).json();
    assert.deepEqual(saved.selections, selected);
    assert.equal(saved.appliedToChat, false);
    assert.equal(
      (
        await app.handle(
          settingsRequest(`/api/projects/${p.id}/integrations`, "PUT", {
            revision: saved.revision,
            selections: empty,
            token: "not-accepted",
          }),
        )
      ).status,
      400,
    );
    assert.equal(network, 0);
    assert.equal(
      sdk.calls.length,
      0,
      "opening/saving selections cannot start a session",
    );
    const root = `/api/projects/${p.id}/chat`;
    assert.equal(
      (
        await app.handle(
          settingsRequest(`${root}/turns`, "POST", {
            prompt: "No ambient permission",
          }),
        )
      ).status,
      400,
    );
    assert.equal(
      sdk.calls.length,
      0,
      "preferences do not replace fresh research disclosure authorization",
    );
    const previewResponse = await app.handle(
      settingsRequest(`${root}/context`, "POST", {
        prompt: "Authorized inert-preferences control",
        selections: [],
      }),
    );
    assert.equal(previewResponse.status, 200);
    const preview: {
      grantId: string;
      context: { fingerprint: string; wire: string };
    } = await previewResponse.json();
    assert.ok(!preview.context.wire.includes("tooluniverse"));
    assert.ok(!preview.context.wire.includes(selected.skills[0]));
    sdk.enqueue({
      onCreate: async (call) => {
        const config = call.config;
        assert.ok(config);
        assert.deepEqual(config.mcpServers, {});
        assert.deepEqual(config.customAgents, []);
        assert.deepEqual(config.skillDirectories, []);
        assert.deepEqual(config.agentDirectories, []);
        assert.deepEqual(config.instructionDirectories, []);
        assert.equal(config.enableSkills, false);
        assert.equal(config.enableConfigDiscovery, false);
        assert.equal(config.skipCustomInstructions, true);
        assert.ok(Array.isArray(config.excludedTools));
        assert.ok(config.excludedTools.includes("builtin:*"));
        assert.ok(config.excludedTools.includes("mcp:*"));
        assert.ok(Array.isArray(config.availableTools));
        assert.ok(
          config.availableTools.every((name) => name.startsWith("custom:")),
        );
        assert.ok(config.onPermissionRequest);
        assert.equal(
          (
            await config.onPermissionRequest(
              {
                kind: "mcp",
                serverName: "tooluniverse",
                toolName: "synthetic",
                toolTitle: "Synthetic fixture",
                readOnly: true,
              },
              { sessionId: call.sessionId },
            )
          ).kind,
          "reject",
        );
      },
    });
    const turn = await app.handle(
      settingsRequest(`${root}/turns`, "POST", {
        prompt: "Authorized inert-preferences control",
        selections: [],
        grantId: preview.grantId,
        fingerprint: preview.context.fingerprint,
        requestId: randomUUID(),
      }),
    );
    assert.equal(turn.status, 200);
    assert.equal((await turn.json()).state, "completed");
    assert.equal(sdk.calls.length, 1);
    assert.equal(network, 0);
    assert.equal(sdk.calls[0].stops, 1);
    assert.equal(sdk.calls[0].disconnects, 1);
  },
);
