import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceFixture } from "./helpers/workspace";
import type { Notebook } from "../src/server/notebooks";

/** @id TEST-NH-007 @verifies REQ-NH-003 REQ-NH-004 REQ-NH-007 */
test(
  "TEST-NH-007 ELN saved history has bilingual inert diffs, guarded restore and explicit Git errors",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture();
    t.after(() => f.close());
    const path = `/api/projects/${f.project.id}/notebooks/${f.notebook.id}`;
    async function openNotebook() {
      await f.page.goto(`${f.origin}/projects/${f.project.id}`);
      await f.page
        .getByRole("complementary", { name: "ファイルエクスプローラー" })
        .getByRole("button", { name: f.notebook.name, exact: true })
        .click();
      await f.page
        .getByRole("tabpanel")
        .getByRole("heading", {
          name: f.notebook.name,
          exact: true,
        })
        .waitFor();
    }
    await openNotebook();
    assert.equal(
      await f.page
        .getByRole("button", { name: "保存履歴", exact: true })
        .count(),
      1,
      "the selected ELN must expose saved edit history separately from run history",
    );
    const currentResponse = await f.page.request.get(`${f.origin}${path}`);
    assert.equal(currentResponse.status(), 200);
    const original: Notebook = await currentResponse.json();
    const changed = structuredClone(original.document);
    changed.cells[0].source = "print(43)";
    const saved = await f.page.request.put(`${f.origin}${path}`, {
      data: {
        revision: original.revision,
        document: changed,
        editorName: "History Editor",
      },
    });
    assert.equal(saved.status(), 200);
    await openNotebook();
    await f.page.getByRole("button", { name: "保存履歴", exact: true }).click();
    const history = f.page.getByRole("dialog", {
      name: "保存履歴",
      exact: true,
    });
    await history
      .getByRole("button", { name: "リビジョン 1", exact: true })
      .click();
    assert.match(await history.innerText(), /自己申告/);
    assert.match(
      await history.locator("pre").first().innerText(),
      /print\(42\)/,
    );
    assert.equal(
      await history.locator("script,iframe,object,embed").count(),
      0,
    );
    await history
      .getByRole("button", { name: "現在版との差分", exact: true })
      .click();
    await history.getByText("print(43)", { exact: true }).waitFor();
    await history
      .getByRole("button", { name: "この版を復元", exact: true })
      .click();
    const confirm = f.page.getByRole("dialog", {
      name: "保存版の復元を確認",
      exact: true,
    });
    await confirm
      .getByRole("button", { name: "キャンセル", exact: true })
      .click();
    let unchanged: Notebook = await (
      await f.page.request.get(`${f.origin}${path}`)
    ).json();
    assert.equal(unchanged.revision, 2);
    await history
      .getByRole("button", { name: "この版を復元", exact: true })
      .click();
    await confirm
      .getByRole("button", { name: "新しい版として復元", exact: true })
      .click();
    await f.page
      .locator(".notebook-document")
      .getByText("保存リビジョン 3", { exact: true })
      .waitFor();
    unchanged = await (await f.page.request.get(`${f.origin}${path}`)).json();
    assert.equal(unchanged.document.cells[0].source, "print(42)");
    assert.equal(unchanged.revision, 3);
    const runs = await (
      await f.page.request.get(`${f.origin}${path}/history`)
    ).json();
    assert.deepEqual(runs.runs, [], "restoring must not execute a notebook");

    const source = f.page.locator(".notebook-document textarea").first();
    await source.fill("print('unsaved-history-draft')");
    await f.page.getByRole("button", { name: "保存履歴", exact: true }).click();
    await history
      .getByRole("button", { name: "リビジョン 1", exact: true })
      .click();
    await history.locator("pre").first().waitFor();
    assert.equal(
      await history
        .getByRole("button", { name: "この版を復元", exact: true })
        .isDisabled(),
      true,
    );
    await history.getByRole("button", { name: "閉じる", exact: true }).click();
    assert.equal(await source.inputValue(), "print('unsaved-history-draft')");

    await f.page.route(`**${path}/versions?*`, async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      value.git = {
        ...value.git,
        status: "error",
        errorCode: "GIT_EXPORT_FAILED",
      };
      await route.fulfill({ response, json: value });
    });
    await f.page.getByRole("button", { name: "保存履歴", exact: true }).click();
    await history
      .getByRole("alert")
      .filter({ hasText: "GIT_EXPORT_FAILED" })
      .waitFor();
    assert.equal(
      await history
        .getByRole("button", { name: "Git 出力を再試行", exact: true })
        .isEnabled(),
      true,
    );
    await history.getByRole("button", { name: "閉じる", exact: true }).click();

    await f.page
      .getByRole("button", { name: "AIRA Nexus の設定", exact: true })
      .click();
    await f.page
      .getByRole("combobox", { name: "表示言語", exact: true })
      .selectOption("en");
    await f.page
      .getByRole("dialog", { name: "AIRA Nexus settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await f.page
      .getByRole("button", { name: "Saved history", exact: true })
      .click();
    const english = f.page.getByRole("dialog", {
      name: "Saved history",
      exact: true,
    });
    await english
      .getByRole("button", { name: "Revision 1", exact: true })
      .click();
    await english.locator("pre").first().waitFor();
    assert.equal(
      await english
        .getByRole("button", { name: "Restore this version", exact: true })
        .isDisabled(),
      true,
    );
    await english.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(await source.inputValue(), "print('unsaved-history-draft')");

    const archivedPage = await f.browser.newPage();
    await archivedPage.goto(`${f.origin}/projects/${f.archived.id}`);
    await archivedPage
      .getByRole("complementary", { name: "ファイルエクスプローラー" })
      .getByRole("button", { name: "Archived notebook", exact: true })
      .click();
    await archivedPage
      .getByRole("button", { name: "保存履歴", exact: true })
      .click();
    const archivedHistory = archivedPage.getByRole("dialog", {
      name: "保存履歴",
      exact: true,
    });
    await archivedHistory
      .getByRole("button", { name: "リビジョン 1", exact: true })
      .click();
    await archivedHistory.locator("pre").first().waitFor();
    assert.equal(
      await archivedHistory
        .getByRole("button", { name: "この版を復元", exact: true })
        .isDisabled(),
      true,
    );
    await archivedHistory
      .getByRole("button", { name: "閉じる", exact: true })
      .click();
    await archivedPage.close();
  },
);
