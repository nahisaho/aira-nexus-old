import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { chromium } from "@playwright/test";
import { testDatabase } from "./database";
import { Operations } from "../../src/server/operations";
import { Sessions } from "../../src/server/sessions";
import { FileStorage, storageDirectory } from "../../src/server/file-storage";
import { Files } from "../../src/server/files";
import { Provenance } from "../../src/server/provenance";
import { Notebooks } from "../../src/server/notebooks";
import { Proposals } from "../../src/server/proposals";
import { Exchange } from "../../src/server/exchange";
import { connectDatabase } from "../../src/server/database";

export async function workspaceFixture(production = true) {
  const db = await testDatabase();
  const cleanup: (() => Promise<unknown>)[] = [() => db.cleanup()];
  let closed = false;
  async function dispose() {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "WORKSPACE_FIXTURE_CLEANUP_FAILED");
  }
  try {
    const operations = new Operations(db.state, db.credentials);
    cleanup.push(() => operations.close());
    await operations.acquire();
    const sessions = new Sessions(operations, db.state, db.credentials);
    cleanup.push(() => sessions.close());
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
    const notebooks = new Notebooks(
      operations,
      provenance,
      {
        async epoch() {
          return null;
        },
        async invalidate() {},
      },
      db.state,
      db.credentials,
    );
    cleanup.push(() => notebooks.close());
    const proposals = new Proposals(
      operations,
      notebooks,
      db.state,
      db.credentials,
    );
    cleanup.push(() => proposals.close());
    const project = await sessions.createProject("local", "研究プロジェクト");
    const other = await sessions.createProject("local", "別の研究");
    const archived = await sessions.createProject("local", "アーカイブ研究");
    const document = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: "Code-A",
          cell_type: "code",
          source: "print(42)",
          metadata: { aira: { language: "python", sharing: [] } },
          outputs: [],
          execution_count: null,
        },
        {
          id: "Markdown-A",
          cell_type: "markdown",
          source: "# Markdown $x^2$\n<script>globalThis.__airaXss=1</script>",
          metadata: {},
        },
      ],
    };
    const notebook = await notebooks.create("local", project.id, {
      name: "研究ノート",
      document,
    });
    const imported = await new Exchange(notebooks).import(
      "local",
      project.id,
      "Imported history",
      Buffer.from(JSON.stringify(document)),
    );
    const file = await files.upload(
      "local",
      project.id,
      "report.md",
      "text/markdown",
      (async function* () {
        yield Buffer.from(
          "AUROC=0.83 <script>globalThis.__airaXss=1</script> FILE_UNSELECTED_SENTINEL",
        );
      })(),
    );
    const proposal = await proposals.propose("local", project.id, {
      kind: "change-cell",
      notebookId: notebook.id,
      revision: notebook.revision,
      cell: {
        id: "Code-A",
        cell_type: "code",
        source: "print(43)",
        language: "python",
        sharing: [],
      },
    });
    const archivedNotebook = await notebooks.create("local", archived.id, {
      name: "Archived notebook",
      document,
    });
    await proposals.propose("local", archived.id, {
      kind: "change-cell",
      notebookId: archivedNotebook.id,
      revision: archivedNotebook.revision,
      cell: {
        id: "Code-A",
        cell_type: "code",
        source: "print(99)",
        language: "python",
        sharing: [],
      },
    });
    await operations.write((client) =>
      client.query("UPDATE projects SET status='archived' WHERE id=$1", [
        archived.id,
      ]),
    );
    while (cleanup.length > 1) await cleanup.pop()!();
    const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
    cleanup.push(() => admin.end());
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "test/helpers/workspace-server.ts",
        db.state,
        production ? "production" : "development",
      ],
      {
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: "1",
          AIRA_STATE_DIR: db.state,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    cleanup.push(async () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return;
      const exited = new Promise<void>((done) =>
        child.once("exit", () => done()),
      );
      child.kill("SIGTERM");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("WORKSPACE_SHUTDOWN_DEADLINE\n" + log));
            }, 15000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    });
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += String(chunk);
    });
    const lines = createInterface({ input: child.stdout });
    cleanup.push(async () => {
      lines.close();
    });
    const origin = await new Promise<string>((done, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WORKSPACE_START_DEADLINE\n" + log)),
        90000,
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`WORKSPACE_EXIT_${code}\n${log}`));
      });
      lines.on("line", (line) => {
        log += line + "\n";
        if (line.startsWith("AIRA_WORKSPACE_READY ")) {
          clearTimeout(timeout);
          done(line.slice("AIRA_WORKSPACE_READY ".length));
        }
      });
    });
    const browser = await chromium.launch();
    cleanup.push(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1100, height: 900 },
    });
    return {
      ...db,
      project,
      other,
      archived,
      notebook,
      imported,
      file,
      proposal,
      origin,
      browser,
      page,
      admin,
      close: dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "WORKSPACE_SETUP_CLEANUP_FAILED",
      );
    }
    throw error;
  }
}
export type WorkspaceFixture = Awaited<ReturnType<typeof workspaceFixture>>;
async function navigateProject(f: WorkspaceFixture, name: string) {
  const link = f.page.getByRole("link", { name, exact: true });
  if (!(await link.isVisible()))
    await f.page
      .getByRole("button", {
        name: "プロジェクトペインを切り替え",
        exact: true,
      })
      .click();
  await link.click();
}
async function openLabNotebook(f: WorkspaceFixture, name: string) {
  await f.page.getByRole("tab", { name: "AI Chat", exact: true }).waitFor();
  assert.deepEqual(
    (await f.page.getByRole("tab").allTextContents()).slice(0, 2),
    ["AI Chat", "実験ノート"],
    "[qualification:fixed-chat-and-independent-journal]",
  );
  await showFileExplorer(f);
  await f.page
    .getByRole("complementary", {
      name: "ファイルエクスプローラー",
      exact: true,
    })
    .getByRole("button", { name, exact: true })
    .click();
  assert.equal(await f.page.getByRole("tab", { name, exact: true }).count(), 1);
}
async function showFileExplorer(f: WorkspaceFixture) {
  const explorer = f.page.getByRole("complementary", {
    name: "ファイルエクスプローラー",
    exact: true,
  });
  if (!(await explorer.isVisible()))
    await f.page
      .getByRole("button", { name: "エクスプローラーを切り替え", exact: true })
      .click();
}
export async function projectFlow(f: WorkspaceFixture) {
  const response = await f.page.request.get(`${f.origin}/api/projects`);
  assert.equal(response.status(), 200);
  await f.page.goto(`${f.origin}/projects/${f.project.id}`);
  await f.page
    .getByRole("heading", { name: f.project.name, exact: true })
    .waitFor();
  assert.equal(
    await f.page.getByRole("button", { name: "新規チャット" }).count(),
    0,
  );
  const scopedPrompt = `Project-only discussion ${f.project.id}`;
  await f.page.getByLabel("メッセージ").fill(scopedPrompt);
  await f.page.getByRole("button", { name: "送信内容を確認" }).click();
  await f.page
    .getByRole("button", { name: "承認して実行", exact: true })
    .click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  await f.page.getByText(scopedPrompt, { exact: true }).waitFor();
  await openLabNotebook(f, f.notebook.name);
  assert.equal(
    await f.page.getByLabel("ソース Code-A").inputValue(),
    "print(42)",
  );
  await f.page.reload();
  await openLabNotebook(f, f.notebook.name);
  assert.equal(
    await f.page.getByLabel("ソース Code-A").inputValue(),
    "print(42)",
  );
  await f.page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await f.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await navigateProject(f, f.other.name);
  await f.page
    .getByRole("heading", { name: f.other.name, exact: true })
    .waitFor();
  await f.page.locator('section[aria-busy="false"]').waitFor();
  assert.equal(await f.page.getByText("print(42)", { exact: true }).count(), 0);
  assert.equal(
    await f.page.getByText(scopedPrompt, { exact: true }).count(),
    0,
  );
  assert.equal(
    await f.page.getByText(/Controlled science response/).count(),
    0,
  );
  await navigateProject(f, f.project.name);
  await f.page
    .getByRole("heading", { name: f.project.name, exact: true })
    .waitFor();
  await f.page.reload();
  await f.page.getByText(scopedPrompt, { exact: true }).waitFor();
  await f.page
    .getByText(/Controlled science response/)
    .first()
    .waitFor();
}
export async function confirmationFlow(f: WorkspaceFixture) {
  const response = await f.page.request.get(`${f.origin}/api/projects`);
  assert.equal(response.status(), 200);
  const existingTurns = (
    await f.admin.query("SELECT count(*)::integer AS n FROM chat_turns")
  ).rows[0].n;
  await f.page.goto(`${f.origin}/projects/${f.project.id}`);
  await f.page
    .getByRole("heading", { name: f.project.name, exact: true })
    .waitFor();
  await f.page.getByLabel("メッセージ").fill("科学の相談");
  await f.page.getByRole("button", { name: "送信内容を確認" }).click();
  await f.page.getByRole("dialog").waitFor();
  assert.match(await f.page.getByRole("dialog").innerText(), /科学の相談/);
  assert.equal(
    (await f.admin.query("SELECT count(*)::integer AS n FROM chat_turns"))
      .rows[0].n,
    existingTurns,
  );
  await f.page.getByRole("button", { name: "拒否", exact: true }).click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await f.admin.query("SELECT count(*)::integer AS n FROM chat_turns"))
      .rows[0].n,
    existingTurns,
  );
  await f.page.getByRole("button", { name: "送信内容を確認" }).click();
  await f.page
    .getByRole("button", { name: "承認して実行", exact: true })
    .click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  await f.page
    .getByText(/Controlled science response/)
    .first()
    .waitFor();
  assert.equal(
    await f.page
      .getByRole("checkbox", { name: /科学表記|Scientific notation/ })
      .count(),
    0,
  );
  await f.page.locator("math:visible").first().waitFor();
  assert.equal(
    await f.page.evaluate(() => Reflect.get(globalThis, "__airaXss")),
    undefined,
  );
  assert.equal(
    (await f.admin.query("SELECT count(*)::integer AS n FROM chat_turns"))
      .rows[0].n,
    existingTurns + 1,
  );
  await f.page.getByRole("button", { name: "提案を確認" }).first().click();
  assert.match(await f.page.getByRole("dialog").innerText(), /print\(43\)/);
  await f.page.getByRole("button", { name: "拒否", exact: true }).click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (
      await f.admin.query("SELECT document FROM notebooks WHERE id=$1", [
        f.notebook.id,
      ])
    ).rows[0].document.cells[0].source,
    "print(42)",
  );
  const proposal = await f.page.request.post(
    `${f.origin}/api/projects/${f.project.id}/proposals`,
    {
      data: {
        kind: "change-cell",
        notebookId: f.notebook.id,
        revision: 1,
        cell: {
          id: "Code-A",
          cell_type: "code",
          source: "print(44)",
          language: "python",
          sharing: [],
        },
      },
    },
  );
  assert.equal(proposal.status(), 201);
  await f.page.reload();
  await f.page.getByRole("button", { name: "提案を確認" }).first().click();
  assert.match(await f.page.getByRole("dialog").innerText(), /print\(42\)/);
  assert.match(await f.page.getByRole("dialog").innerText(), /print\(44\)/);
  await f.page
    .getByRole("button", { name: "承認して実行", exact: true })
    .click();
  await openLabNotebook(f, f.notebook.name);
  await f.page.getByLabel("ソース Code-A").waitFor();
  assert.equal(
    await f.page.getByLabel("ソース Code-A").inputValue(),
    "print(44)",
  );
  await f.page.getByLabel("入力 report.md").check();
  await f.page
    .getByRole("button", { name: "実行内容を確認 Code-A", exact: true })
    .click();
  const exact = await f.page.getByRole("dialog").innerText();
  assert.match(exact, /print\(44\)/);
  assert.match(exact, /python/);
  assert.match(exact, new RegExp(f.file.sha256));
  assert.equal(
    (
      await f.admin.query(
        "SELECT count(*)::integer AS n FROM jobs WHERE purpose='execution'",
      )
    ).rows[0].n,
    0,
  );
  await f.page.getByRole("button", { name: "拒否", exact: true }).click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  await f.page
    .getByRole("button", { name: "実行内容を確認 Code-A", exact: true })
    .click();
  await f.page.getByRole("dialog").waitFor();
  const beforeEditResponse = await f.page.request.get(
    `${f.origin}/api/projects/${f.project.id}/notebooks/${f.notebook.id}`,
  );
  const beforeEdit = await beforeEditResponse.json();
  beforeEdit.document.cells[0].source = "print(46)";
  const edited = await f.page.request.put(
    `${f.origin}/api/projects/${f.project.id}/notebooks/${f.notebook.id}`,
    { data: { revision: beforeEdit.revision, document: beforeEdit.document } },
  );
  assert.equal(edited.status(), 200);
  await f.page
    .getByRole("button", { name: "承認して実行", exact: true })
    .click();
  await f.page.getByRole("alert").filter({ hasText: "409" }).first().waitFor();
  assert.equal(
    (
      await f.admin.query(
        "SELECT count(*)::integer AS n FROM jobs WHERE purpose='execution'",
      )
    ).rows[0].n,
    0,
  );
  await f.page.getByRole("button", { name: "拒否", exact: true }).click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  await f.page
    .getByRole("button", { name: "実行内容を確認 Code-A", exact: true })
    .click();
  await f.page
    .getByRole("button", { name: "承認して実行", exact: true })
    .click();
  await f.page
    .getByText("実行完了", { exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(
    (
      await f.admin.query(
        "SELECT count(*)::integer AS n FROM jobs WHERE purpose='execution'",
      )
    ).rows[0].n,
    1,
  );
  await f.page.getByLabel("ソース Code-A").fill("print(45)");
  await f.page
    .getByRole("button", { name: "Notebook を保存", exact: true })
    .click();
  await f.page.getByText("古い実行結果", { exact: true }).first().waitFor();
  await f.page
    .getByRole("button", { name: "カーネルを再起動", exact: true })
    .click();
  await f.page
    .getByRole("button", { name: "承認して実行", exact: true })
    .click();
  await f.page.getByText("カーネル状態喪失", { exact: true }).first().waitFor();
  await f.page
    .getByRole("button", { name: "結果をチャットへ", exact: true })
    .click();
  await f.page.getByLabel("メッセージ").fill("この実行結果について");
  const resultContext = f.page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/projects/${f.project.id}/chat/context`) &&
      response.request().method() === "POST",
  );
  await f.page.getByRole("button", { name: "送信内容を確認" }).click();
  assert.equal((await resultContext).status(), 200);
  const resultWire = await f.page.getByRole("dialog").innerText();
  assert.match(resultWire, /46/);
  assert.ok(!resultWire.includes("output_type"));
  await f.page.getByRole("button", { name: "拒否", exact: true }).click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    (await f.admin.query("SELECT count(*)::integer AS n FROM chat_turns"))
      .rows[0].n,
    existingTurns + 1,
  );
  await showFileExplorer(f);
  await f.page.getByRole("button", { name: "report.md", exact: true }).click();
  await f.page.getByLabel("開始位置").fill("0");
  await f.page.getByLabel("終了位置").fill("5");
  await f.page
    .getByRole("button", { name: "選択範囲をチャットへ", exact: true })
    .click();
  await f.page.getByLabel("メッセージ").fill("選択範囲について");
  await f.page.getByRole("button", { name: "送信内容を確認" }).click();
  const wire = await f.page.getByRole("dialog").innerText();
  assert.match(wire, /AUROC/);
  assert.ok(!wire.includes("FILE_UNSELECTED_SENTINEL"));
  await f.page
    .getByRole("button", { name: "承認して実行", exact: true })
    .click();
  await f.page.getByText("送信完了", { exact: true }).waitFor();
  assert.equal(
    (await f.admin.query("SELECT count(*)::integer AS n FROM chat_turns"))
      .rows[0].n,
    existingTurns + 2,
  );
}
export async function safetyFlow(f: WorkspaceFixture) {
  const response = await f.page.request.get(`${f.origin}/api/projects`);
  assert.equal(response.status(), 200);
  await f.page.goto(`${f.origin}/projects/${f.project.id}`);
  await openLabNotebook(f, f.notebook.name);
  await f.page
    .getByRole("group", { name: "Markdownセルの表示 Markdown-A", exact: true })
    .waitFor();
  assert.equal(
    await f.page.locator("script").filter({ hasText: "__airaXss=1" }).count(),
    0,
  );
  assert.equal(
    await f.page.evaluate(() => Reflect.get(globalThis, "__airaXss")),
    undefined,
  );
  await f.page.locator("math:visible").first().waitFor();
  assert.ok(
    (
      await f.page
        .getByRole("tabpanel")
        .locator(".scientific")
        .allTextContents()
    ).some((text) => text.includes("<script>globalThis.__airaXss=1</script>")),
    "Default scientific Markdown must preserve literal HTML without executing it",
  );
  assert.equal(
    await f.page.evaluate(() => Reflect.get(globalThis, "__airaXss")),
    undefined,
  );
  const rendered = await f.page.request.post(`${f.origin}/api/render`, {
    data: { source: "$x^2$", projectId: f.project.id },
  });
  assert.equal(rendered.status(), 200);
  const view = await rendered.json();
  assert.deepEqual(view.errors, []);
  assert.match(view.html, /<math/);
  const currentResponse = await f.page.request.get(
    `${f.origin}/api/projects/${f.project.id}/notebooks/${f.notebook.id}`,
  );
  const current = await currentResponse.json();
  const pending = await f.page.request.post(
    `${f.origin}/api/projects/${f.project.id}/proposals`,
    {
      data: {
        kind: "change-cell",
        notebookId: current.id,
        revision: current.revision,
        cell: {
          id: "Code-A",
          cell_type: "code",
          source: "print(100)",
          language: "python",
          sharing: [],
        },
      },
    },
  );
  assert.equal(pending.status(), 201);
  await f.page.reload();
  await f.page.getByRole("button", { name: "提案を確認" }).first().click();
  current.document.cells[0].source = "print(99)";
  const changed = await f.page.request.put(
    `${f.origin}/api/projects/${f.project.id}/notebooks/${current.id}`,
    { data: { revision: current.revision, document: current.document } },
  );
  assert.equal(changed.status(), 200);
  await f.page
    .getByRole("button", { name: "承認して実行", exact: true })
    .click();
  await f.page.getByRole("alert").filter({ hasText: "409" }).first().waitFor();
  await f.page.getByRole("button", { name: "拒否", exact: true }).click();
  await f.page.getByRole("dialog").waitFor({ state: "hidden" });
  await openLabNotebook(f, "Imported history");
  await f.page.getByText("インポート履歴・未実行", { exact: true }).waitFor();
  await showFileExplorer(f);
  await f.page.getByRole("button", { name: "report.md", exact: true }).click();
  await f.page.getByLabel("終了位置").waitFor();
  await f.page.getByRole("tabpanel").locator(".scientific").waitFor();
  assert.ok(
    (
      await f.page
        .getByRole("tabpanel")
        .locator(".scientific")
        .allTextContents()
    ).some((text) => text.includes("<script>globalThis.__airaXss=1</script>")),
    "Default scientific file preview must preserve literal HTML without executing it",
  );
  assert.equal(
    await f.page.evaluate(() => Reflect.get(globalThis, "__airaXss")),
    undefined,
  );
  await f.page
    .getByRole("button", { name: "ローカルチェック", exact: true })
    .click();
  await f.page.getByText("科学的妥当性は未検証", { exact: true }).waitFor();
  await f.page
    .getByRole("link", { name: f.archived.name, exact: true })
    .click();
  await f.page
    .getByText("アーカイブ済み・読み取り専用", { exact: true })
    .waitFor();
  assert.equal(
    await f.page.getByRole("button", { name: "送信内容を確認" }).isDisabled(),
    true,
  );
  assert.equal(await f.page.getByLabel("メッセージ").isDisabled(), true);
  await f.page
    .getByRole("button", {
      name: `プロジェクトメニュー ${f.archived.name}`,
      exact: true,
    })
    .click();
  assert.equal(
    await f.page
      .getByRole("menuitem", { name: "アーカイブ", exact: true })
      .isDisabled(),
    true,
  );
  await f.page.keyboard.press("Escape");
  assert.equal(
    await f.page
      .getByRole("button", { name: "提案を確認", exact: true })
      .isDisabled(),
    true,
  );
  await showFileExplorer(f);
  assert.equal(
    await f.page
      .getByRole("button", { name: "Notebook を作成", exact: true })
      .isDisabled(),
    true,
  );
  await showFileExplorer(f);
  assert.equal(
    await f.page.getByLabel("ファイルをアップロード").isDisabled(),
    true,
  );
}
