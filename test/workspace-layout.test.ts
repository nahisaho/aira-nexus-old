import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Request as BrowserRequest } from "@playwright/test";
import { workspaceFixture, type WorkspaceFixture } from "./helpers/workspace";
import { deferred, bounded } from "./helpers/copilot";
import sharp from "sharp";
import { parseDocument } from "yaml";
import type { FileVersion } from "../src/server/files";
import type { Notebook } from "../src/server/notebooks";
async function open(f: WorkspaceFixture) {
  await f.page.goto(`${f.origin}/projects/${f.project.id}`);
  await f.page
    .getByRole("heading", { name: f.project.name, exact: true })
    .waitFor();
}
/** @id TEST-LAYOUT-011 @verifies REQ-LAYOUT-002 REQ-LAYOUT-003 REQ-UI-001 */
test(
  "TEST-LAYOUT-011 fixed independent project Lab Note retains drafts beside multiple ipynb",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    const journalUrl = `**/api/projects/${f.project.id}/lab-note`;
    await f.page.route(journalUrl, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ code: "PROJECT_LAB_NOTE_MISSING" }),
      }),
    );
    await open(f);
    assert.deepEqual(await f.page.getByRole("tab").allTextContents(), [
      "AI Chat",
      "実験ノート",
    ]);
    const tab = f.page.getByRole("tab", {
      name: "実験ノート",
      exact: true,
    });
    assert.notEqual(await tab.getAttribute("draggable"), "true");
    for (const key of ["Alt+ArrowLeft", "Alt+ArrowRight", "Delete"]) {
      await tab.press(key);
      assert.deepEqual(await f.page.getByRole("tab").allTextContents(), [
        "AI Chat",
        "実験ノート",
      ]);
    }
    await tab.click();
    const panel = f.page.getByRole("tabpanel", {
      name: "実験ノート",
      exact: true,
    });
    await panel
      .getByRole("alert")
      .filter({ hasText: "PROJECT_LAB_NOTE_MISSING" })
      .waitFor();
    assert.equal(await tab.isVisible(), true);
    await f.page.unroute(journalUrl);
    await f.page.reload();
    await tab.click();
    await panel
      .getByRole("button", { name: "Markdown セルを追加", exact: true })
      .click();
    await panel.getByRole("button", { name: "Text表記", exact: true }).click();
    const source = panel.getByRole("textbox").first();
    await source.fill("# Project journal\nIndependent record.");
    await f.page.getByRole("link", { name: f.other.name, exact: true }).click();
    await f.page
      .getByRole("dialog", { name: "未保存の変更", exact: true })
      .getByRole("button", { name: "編集を続ける", exact: true })
      .click();
    assert.equal(
      await source.textContent(),
      "# Project journal\nIndependent record.",
    );
    assert.equal(await tab.getAttribute("aria-selected"), "true");
    assert.equal(
      await panel
        .getByRole("button", { name: "コードセルを追加", exact: true })
        .count(),
      0,
    );
    const explorer = f.page.getByRole("complementary", {
      name: "ファイルエクスプローラー",
      exact: true,
    });
    await explorer
      .getByRole("button", { name: f.notebook.name, exact: true })
      .click();
    await f.page
      .getByRole("tabpanel")
      .getByLabel("ソース Code-A", { exact: true })
      .fill("independent ipynb draft");
    await explorer
      .getByRole("button", { name: "Imported history", exact: true })
      .click();
    assert.equal(await f.page.getByRole("tab").count(), 4);
    await tab.click();
    assert.equal(
      await source.textContent(),
      "# Project journal\nIndependent record.",
    );
    const journal: Notebook = await (
      await f.page.request.get(
        `${f.origin}/api/projects/${f.project.id}/lab-note`,
      )
    ).json();
    const saveUrl = `**/api/projects/${f.project.id}/notebooks/${journal.id}`;
    const saveStarted = deferred<void>(),
      releaseSave = deferred<void>();
    await f.page.route(saveUrl, async (route) => {
      if (route.request().method() === "PUT") {
        saveStarted.resolve();
        await releaseSave.promise;
      }
      await route.continue();
    });
    try {
      await panel
        .getByRole("button", { name: "Notebook を保存", exact: true })
        .click();
      await bounded(saveStarted.promise, "journal save admission");
      await f.page
        .getByRole("link", { name: f.other.name, exact: true })
        .click();
      await f.page.locator('[role="alert"], [role="dialog"]').first().waitFor();
      assert.equal(
        await f.page
          .getByRole("alert")
          .filter({ hasText: "NOTEBOOK_BUSY" })
          .count(),
        1,
      );
      assert.equal(
        await f.page
          .getByRole("dialog", { name: "未保存の変更", exact: true })
          .count(),
        0,
      );
      assert.equal(new URL(f.page.url()).pathname, `/projects/${f.project.id}`);
    } finally {
      releaseSave.resolve();
    }
    await panel
      .getByRole("status")
      .filter({ hasText: "保存しました" })
      .waitFor();
    await f.page.unroute(saveUrl);
    await panel.getByRole("button", { name: "Text表記", exact: true }).click();
    assert.match((await source.textContent())!, /Project journal/);
    await panel
      .getByRole("button", { name: "Markdownレンダリング表記", exact: true })
      .click();
    await panel
      .getByRole("heading", { name: "Project journal", exact: true })
      .waitFor();
    await f.page
      .getByRole("tab", { name: f.notebook.name, exact: true })
      .click();
    assert.equal(
      await f.page
        .getByRole("tabpanel")
        .getByLabel("ソース Code-A", { exact: true })
        .inputValue(),
      "independent ipynb draft",
    );
    await f.page
      .getByRole("tabpanel")
      .getByLabel("ソース Code-A", { exact: true })
      .fill("print(42)");
    await f.page
      .getByRole("tabpanel")
      .getByRole("button", { name: "Notebook を保存", exact: true })
      .click();
    await f.page
      .getByRole("tabpanel")
      .getByRole("status")
      .filter({ hasText: "保存しました" })
      .waitFor();
    await f.page.reload();
    await f.page.getByRole("tab", { name: "実験ノート", exact: true }).click();
    await f.page
      .getByRole("tabpanel")
      .getByRole("heading", { name: "Project journal", exact: true })
      .waitFor();
  },
);
/** @id TEST-LAYOUT-007 @verifies REQ-RENDER-004 REQ-RENDER-005 REQ-RENDER-006 REQ-DATA-004 */
test(
  "TEST-LAYOUT-007 Mermaid and owned SVG/PNG render without active markup or foreign requests",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    const external: string[] = [];
    await f.page.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin === f.origin)
        await route.continue();
      else {
        external.push(route.request().url());
        await route.abort();
      }
    });
    const root = `/api/projects/${f.project.id}/files`;
    async function upload(name: string, mime: string, data: Buffer | string) {
      const response = await f.page.request.post(
        `${f.origin}${root}?name=${name}`,
        {
          headers: { "Content-Type": mime },
          data,
        },
      );
      assert.equal(response.status(), 201);
      return response.json();
    }
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100"><rect width="240" height="100" fill="#dbeafe"/><text x="20" y="55" font-size="24">Demo SVG</text></svg>';
    const vector = await upload("media.svg", "image/svg+xml", svg);
    const raster = await upload(
      "media.png",
      "image/png",
      await sharp(Buffer.from(svg)).png().toBuffer(),
    );
    const unsafe = await upload(
      "unsafe.svg",
      "image/svg+xml",
      svg.replace(
        "</svg>",
        '<image href="https://blocked.invalid/pixel"/></svg>',
      ),
    );
    await upload(
      "media-demo.md",
      "text/markdown",
      `# Media Demo\n\n\`\`\`mermaid\nflowchart LR\n A[Input] --> B[Lab Note]\n B --> C[Result]\n\`\`\`\n\n![Demo PNG](aira-file:${raster.id})\n\n![Demo SVG](aira-file:${vector.id})\n\n![Remote image](https://blocked.invalid/remote.png)`,
    );
    await upload(
      "media-blocked.md",
      "text/markdown",
      `\`\`\`mermaid\n%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n A --> B\n\`\`\`\n\n![Unsafe SVG](aira-file:${unsafe.id})`,
    );
    await open(f);
    const explorer = f.page.getByRole("complementary", {
      name: "ファイルエクスプローラー",
      exact: true,
    });
    await explorer
      .getByRole("button", { name: "media-demo.md", exact: true })
      .click();
    const panel = f.page.getByRole("tabpanel", {
      name: "media-demo.md",
      exact: true,
    });
    await panel.locator('[data-mermaid="ready"]').waitFor();
    for (const alt of ["Mermaid図", "Demo PNG", "Demo SVG"]) {
      const image = panel.getByRole("img", { name: alt, exact: true });
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(async (element) => {
        if (!(element instanceof HTMLImageElement))
          throw new Error("IMAGE_REQUIRED");
        await element.decode();
        if (!element.naturalWidth || !element.naturalHeight)
          throw new Error("EMPTY_IMAGE");
      });
    }
    assert.equal(
      await panel
        .locator(".scientific")
        .locator("svg,script,iframe,object,embed")
        .count(),
      0,
    );
    assert.equal(await panel.getByRole("alert").count(), 0);
    await panel
      .getByRole("button", { name: "原文を表示", exact: true })
      .click();
    assert.equal(await panel.locator('[data-mermaid="ready"]').count(), 0);
    assert.match(await panel.locator("pre").innerText(), /```mermaid/);
    await panel
      .getByRole("button", { name: "レンダリングを表示", exact: true })
      .click();
    await panel.locator('[data-mermaid="ready"]').waitFor();
    const vectorResponse = f.page.waitForResponse(
      `${f.origin}${root}/${vector.id}/image`,
    );
    await explorer
      .getByRole("button", { name: "media.svg", exact: true })
      .click();
    const vectorImage = await vectorResponse;
    assert.equal(vectorImage.status(), 200);
    assert.equal(vectorImage.headers()["content-type"], "image/png");
    const vectorPanel = f.page.getByRole("tabpanel", {
      name: "media.svg",
      exact: true,
    });
    const dimensions = await vectorPanel
      .getByRole("img", { name: "media.svg", exact: true })
      .evaluate(async (element) => {
        if (!(element instanceof HTMLImageElement))
          throw new Error("IMAGE_REQUIRED");
        await element.decode();
        if (!element.src.startsWith("data:image/png;base64,"))
          throw new Error("RASTER_PREVIEW_REQUIRED");
        return [element.naturalWidth, element.naturalHeight];
      });
    assert.deepEqual(dimensions, [240, 100]);
    assert.equal(await vectorPanel.getByRole("alert").count(), 0);
    await explorer
      .getByRole("button", { name: "media-blocked.md", exact: true })
      .click();
    const blocked = f.page.getByRole("tabpanel", {
      name: "media-blocked.md",
      exact: true,
    });
    await blocked
      .getByRole("alert")
      .filter({ hasText: "MERMAID_SOURCE_BLOCKED" })
      .waitFor();
    await blocked
      .getByRole("img", { name: "Unsafe SVG", exact: true })
      .scrollIntoViewIfNeeded();
    await blocked
      .getByRole("alert")
      .filter({ hasText: "画像を表示できません" })
      .waitFor();
    assert.equal(await blocked.locator('[data-mermaid="ready"]').count(), 0);
    const unsafeResponse = f.page.waitForResponse(
      `${f.origin}${root}/${unsafe.id}/image`,
    );
    await explorer
      .getByRole("button", { name: "unsafe.svg", exact: true })
      .click();
    assert.equal((await unsafeResponse).status(), 415);
    const unsafePanel = f.page.getByRole("tabpanel", {
      name: "unsafe.svg",
      exact: true,
    });
    await unsafePanel.getByRole("alert").waitFor();
    assert.equal(await unsafePanel.getByRole("img").count(), 0);
    assert.deepEqual(external, []);
  },
);
/** @id TEST-LAYOUT-008 @verifies REQ-RENDER-006 */
test(
  "TEST-LAYOUT-008 Markdown file tabs switch source and rendered views without changing content",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    const source =
      "# Preview modes\n\n| Sample | Value |\n| --- | ---: |\n| A | 20.1 |\n\n$x^2$\n\n<script>globalThis.__markdownToggleXss=1</script>";
    for (const [name, mime, data] of [
      ["modes.markdown", "text/markdown", source],
      ["plain.txt", "text/plain", "# Plain text"],
    ]) {
      const upload = await f.page.request.post(
        `${f.origin}/api/projects/${f.project.id}/files?name=${name}`,
        { headers: { "Content-Type": mime }, data },
      );
      assert.equal(upload.status(), 201);
    }
    await open(f);
    const explorer = f.page.getByRole("complementary", {
      name: "ファイルエクスプローラー",
      exact: true,
    });
    await explorer
      .getByRole("button", { name: "modes.markdown", exact: true })
      .click();
    const panel = f.page.getByRole("tabpanel", {
      name: "modes.markdown",
      exact: true,
    });
    const original = panel.getByRole("button", {
      name: "原文を表示",
      exact: true,
    });
    const rendered = panel.getByRole("button", {
      name: "レンダリングを表示",
      exact: true,
    });
    await panel.getByRole("table").waitFor();
    assert.equal(await rendered.getAttribute("aria-pressed"), "true");
    await original.click();
    assert.equal(await original.getAttribute("aria-pressed"), "true");
    assert.equal(await rendered.getAttribute("aria-pressed"), "false");
    assert.equal(await panel.locator("pre").innerText(), source);
    assert.equal(await panel.locator(".scientific").count(), 0);
    await explorer
      .getByRole("button", { name: "plain.txt", exact: true })
      .click();
    const plain = f.page.getByRole("tabpanel", {
      name: "plain.txt",
      exact: true,
    });
    await plain.getByText("# Plain text", { exact: true }).waitFor();
    assert.equal(
      await plain
        .getByRole("group", { name: "Markdownの表示", exact: true })
        .count(),
      0,
    );
    await f.page
      .getByRole("tab", { name: "modes.markdown", exact: true })
      .click();
    assert.equal(await original.getAttribute("aria-pressed"), "true");
    await rendered.focus();
    await f.page.keyboard.press("Enter");
    await panel.getByRole("table").waitFor();
    assert.equal(await panel.locator("math").count(), 1);
    assert.equal(await original.getAttribute("aria-pressed"), "false");
    assert.equal(await rendered.getAttribute("aria-pressed"), "true");
    assert.equal(await panel.locator("script").count(), 0);
    assert.equal(
      await f.page.evaluate(() =>
        Reflect.get(globalThis, "__markdownToggleXss"),
      ),
      undefined,
    );
    const downloadPath = await panel
      .getByRole("link", { name: "ファイルをダウンロード", exact: true })
      .getAttribute("href");
    assert.ok(downloadPath);
    const download = await f.page.request.get(`${f.origin}${downloadPath}`);
    assert.equal(download.status(), 200);
    assert.equal((await download.body()).toString(), source);
    await f.page
      .getByRole("button", { name: "AIRA Nexus の設定", exact: true })
      .click();
    const settings = f.page.getByRole("dialog", {
      name: "AIRA Nexus の設定",
      exact: true,
    });
    await settings.getByLabel("表示言語", { exact: true }).selectOption("en");
    await f.page
      .getByRole("dialog", { name: "AIRA Nexus settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Show source", exact: true })
      .click();
    assert.equal(await panel.locator("pre").innerText(), source);
    assert.equal(
      await panel
        .getByRole("button", { name: "Show rendered", exact: true })
        .getAttribute("aria-pressed"),
      "false",
    );
  },
);
/** @id TEST-LAYOUT-009 @verifies REQ-MARKDOWN-001 REQ-MARKDOWN-002 REQ-MARKDOWN-003 */
test(
  "TEST-LAYOUT-009 Lab Note modes and self-declared YAML editing history preserve drafts and read-only views",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    await open(f);
    async function editor(name: string) {
      await f.page
        .getByRole("button", { name: "AIRA Nexus の設定", exact: true })
        .click();
      const settings = f.page.getByRole("dialog", {
        name: "AIRA Nexus の設定",
        exact: true,
      });
      await settings.getByLabel("編集者名", { exact: true }).fill(name);
      await settings
        .getByRole("button", { name: "編集者名を保存", exact: true })
        .click();
      await settings
        .getByRole("button", { name: "閉じる", exact: true })
        .click();
    }
    await editor("Demo Author A");
    await f.page.reload();
    const explorer = f.page.getByRole("complementary", {
      name: "ファイルエクスプローラー",
      exact: true,
    });
    const fileBody = "# Uploaded Markdown\n\n$x^2$";
    await explorer
      .getByLabel("ファイルをアップロード", { exact: true })
      .setInputFiles({
        name: "authored.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(fileBody),
      });
    await explorer
      .getByRole("button", { name: "authored.md", exact: true })
      .waitFor();
    const filesResponse = await f.page.request.get(
      `${f.origin}/api/projects/${f.project.id}/files`,
    );
    const listing: { versions: FileVersion[] } = await filesResponse.json();
    const uploaded = listing.versions.find(
      (file) => file.name === "authored.md",
    );
    assert.ok(uploaded);
    const download = await f.page.request.get(
      `${f.origin}/api/projects/${f.project.id}/files/${uploaded.id}/download`,
    );
    assert.equal(download.status(), 200);
    function yaml(source: string) {
      const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
      assert.ok(match);
      return parseDocument(match[1]);
    }
    const uploadedSource = (await download.body()).toString();
    assert.ok(uploadedSource.endsWith(fileBody));
    assert.equal(
      yaml(uploadedSource).getIn(["aira", "editor_history", 0, "editor"]),
      "Demo Author A",
    );
    await explorer
      .getByRole("button", { name: "authored.md", exact: true })
      .click();
    const filePanel = f.page.getByRole("tabpanel", {
      name: "authored.md",
      exact: true,
    });
    await filePanel
      .getByRole("heading", { name: "Uploaded Markdown", exact: true })
      .waitFor();
    await filePanel
      .getByRole("button", { name: "原文を表示", exact: true })
      .click();
    assert.equal(await filePanel.locator("pre").innerText(), uploadedSource);
    await explorer
      .getByRole("button", { name: f.notebook.name, exact: true })
      .click();
    const lab = f.page.getByRole("tabpanel");
    const cell = lab
      .locator(".notebook-cell")
      .filter({ hasText: "markdown · Markdown-A" });
    await cell.locator("math").waitFor();
    assert.equal(await cell.getByRole("textbox").count(), 0);
    await cell.getByRole("button", { name: "原文を表示", exact: true }).click();
    assert.match(await cell.locator("pre").innerText(), /^# Markdown/);
    await cell.getByRole("button", { name: "編集", exact: true }).click();
    const input = cell.getByLabel("ソース Markdown-A", { exact: true });
    await input.fill("# Edited Note\n\n$x^2$");
    await cell
      .getByRole("button", { name: "レンダリングを表示", exact: true })
      .click();
    await cell
      .getByRole("heading", { name: "Edited Note", exact: true })
      .waitFor();
    await cell.getByRole("button", { name: "編集", exact: true }).click();
    assert.equal(await input.inputValue(), "# Edited Note\n\n$x^2$");
    async function save() {
      const response = f.page.waitForResponse(
        (response) =>
          response.url() ===
            `${f.origin}/api/projects/${f.project.id}/notebooks/${f.notebook.id}` &&
          response.request().method() === "PUT",
      );
      await lab
        .getByRole("button", { name: "Notebook を保存", exact: true })
        .click();
      assert.equal((await response).status(), 200);
      await lab.getByText("保存しました", { exact: true }).waitFor();
      const value = await f.page.request.get(
        `${f.origin}/api/projects/${f.project.id}/notebooks/${f.notebook.id}`,
      );
      const notebook: Notebook = await value.json();
      const saved = notebook.document.cells.find(
        (cell) => cell.id === "Markdown-A",
      );
      assert.ok(saved);
      assert.equal(
        notebook.document.cells.find((cell) => cell.id === "Code-A")?.source,
        "print(42)",
      );
      return saved.source;
    }
    const first = await save();
    assert.equal(
      yaml(first).getIn(["aira", "editor_history", 0, "editor"]),
      "Demo Author A",
    );
    assert.equal(
      await save(),
      first,
      "unchanged saves must not append an editor",
    );
    await editor("Demo Author B");
    await input.fill(first.replace("# Edited Note", "# Edited Again"));
    const second = await save();
    assert.equal(
      yaml(second).getIn(["aira", "created_at"]),
      yaml(first).getIn(["aira", "created_at"]),
    );
    assert.equal(
      yaml(second).getIn(["aira", "editor_history", 0, "editor"]),
      "Demo Author A",
    );
    assert.equal(
      yaml(second).getIn(["aira", "editor_history", 1, "editor"]),
      "Demo Author B",
    );
    assert.equal(yaml(second).getIn(["aira", "editor_history", 2]), undefined);
    await f.page.goto(`${f.origin}/projects/${f.archived.id}`);
    await explorer
      .getByRole("button", { name: "Archived notebook", exact: true })
      .click();
    await cell.getByRole("button", { name: "編集", exact: true }).waitFor();
    assert.ok(
      await cell
        .getByRole("button", { name: "編集", exact: true })
        .isDisabled(),
    );
    await cell.getByRole("button", { name: "原文を表示", exact: true }).click();
    assert.match(await cell.locator("pre").innerText(), /^# Markdown/);
    await cell
      .getByRole("button", { name: "レンダリングを表示", exact: true })
      .click();
    await cell.locator("math").waitFor();
  },
);
test(
  "refreshed welcome actions, themed controls and responsive layout",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    await f.page.goto(f.origin);
    const start = f.page.getByRole("button", {
      name: "新しい研究を始める",
      exact: true,
    });
    await start.click();
    const dialog = f.page.getByRole("dialog", {
      name: "プロジェクトを追加",
      exact: true,
    });
    await dialog.getByLabel("プロジェクト名", { exact: true }).fill("New idea");
    await f.page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert.ok(
      await start.evaluate((element) => element === document.activeElement),
    );
    const colors = await start.evaluate((element) => {
      const style = getComputedStyle(element);
      return { text: style.color, background: style.backgroundColor };
    });
    assert.notEqual(colors.text, colors.background);
    assert.notEqual(colors.background, "rgba(0, 0, 0, 0)");
    await f.page
      .getByRole("button", { name: "AIRA Nexus の設定", exact: true })
      .click();
    const settings = f.page.getByRole("dialog", {
      name: "AIRA Nexus の設定",
      exact: true,
    });
    await settings.getByLabel("テーマ", { exact: true }).selectOption("dark");
    await settings.getByRole("button", { name: "閉じる", exact: true }).click();
    assert.notEqual(
      await start.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
      colors.background,
    );
    for (const width of [1440, 960, 390]) {
      await f.page.setViewportSize({ width, height: 900 });
      assert.ok(
        await f.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `welcome must fit the ${width}px viewport`,
      );
      assert.ok(
        await start.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth;
        }),
      );
    }
    const projectToggle = f.page.getByRole("button", {
      name: "プロジェクトペインを切り替え",
      exact: true,
    });
    if ((await projectToggle.getAttribute("aria-expanded")) === "true")
      await projectToggle.click();
    await start.click();
    await f.page
      .getByRole("dialog", { name: "プロジェクトを追加", exact: true })
      .getByLabel("プロジェクト名", { exact: true })
      .waitFor();
  },
);
/** @id TEST-DIAG-003 @verifies REQ-DIAG-003 */
test(
  "TEST-DIAG-003 Diagnostics runs manually in settings without center toolbar actions",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    const entered = deferred(),
      release = deferred();
    let calls = 0;
    const result = {
      ready: true,
      events: [
        {
          id: "diagnostic-result",
          timestamp: "2026-11-11T00:00:00Z",
          component: "socket",
          status: "ready",
          code: "SOCKET_READY",
          action: "Check the database socket.",
        },
      ],
    };
    await f.page.route("**/api/readiness", async (route) => {
      calls++;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
        await route.fulfill({ json: result });
      } else {
        await route.fulfill({
          status: 503,
          json: { code: "DIAGNOSTICS_UNAVAILABLE" },
        });
      }
    });
    await f.page.goto(f.origin);
    await f.page
      .getByRole("button", { name: "AIRA Nexus の設定", exact: true })
      .click();
    let settings = f.page.getByRole("dialog", {
      name: "AIRA Nexus の設定",
      exact: true,
    });
    await settings
      .getByText("削除したプロジェクトはありません", { exact: true })
      .waitFor();
    assert.equal(calls, 0, "opening settings must not run readiness probes");
    const run = settings.getByRole("button", {
      name: "診断を実行",
      exact: true,
    });
    try {
      await run.click();
      await bounded(entered.promise, "manual diagnostics request");
      assert.ok(await run.isDisabled());
      assert.ok(
        await settings
          .getByRole("button", { name: "閉じる", exact: true })
          .isDisabled(),
      );
    } finally {
      release.resolve();
    }
    const output = settings.locator('pre[aria-label="診断結果"]');
    await output.waitFor();
    assert.deepEqual(JSON.parse(await output.innerText()), result);
    await run.click();
    await settings.getByRole("alert").waitFor();
    assert.match(
      await settings.getByRole("alert").innerText(),
      /DIAGNOSTICS_UNAVAILABLE/,
    );
    assert.equal(
      await output.count(),
      0,
      "a failed rerun must not retain an old success",
    );
    await settings.getByRole("button", { name: "閉じる", exact: true }).click();
    await open(f);
    const center = f.page.getByRole("region", {
      name: "作業領域",
      exact: true,
    });
    for (const name of ["ファイル", "診断"])
      assert.equal(
        await center.getByRole("button", { name, exact: true }).count(),
        0,
      );
    await f.page
      .getByRole("button", { name: "AIRA Nexus の設定", exact: true })
      .click();
    settings = f.page.getByRole("dialog", {
      name: "AIRA Nexus の設定",
      exact: true,
    });
    await settings
      .getByText("削除したプロジェクトはありません", { exact: true })
      .waitFor();
    assert.equal(calls, 2, "reopening settings must not run readiness probes");
    assert.ok(
      await settings
        .getByRole("button", { name: "診断を実行", exact: true })
        .isEnabled(),
    );
  },
);
/** @id TEST-LAYOUT-010 @verifies REQ-LAYOUT-005 */
test(
  "TEST-LAYOUT-010 project search, persistent pins and recent ordering share the revised menu",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    const edit = await f.page.request.patch(
      `${f.origin}/api/projects/${f.other.id}`,
      {
        data: { revision: f.other.revision, description: "Protein Alpha" },
      },
    );
    assert.equal(edit.status(), 200);
    await open(f);
    const left = f.page.getByRole("complementary", {
      name: "プロジェクト管理",
      exact: true,
    });
    const pinned = left.getByRole("region", {
      name: "ピン止め済み",
      exact: true,
    });
    const recent = left.getByRole("region", {
      name: "最近のプロジェクト",
      exact: true,
    });
    assert.equal(await pinned.getByRole("link").count(), 0);
    assert.equal(
      await recent.getByRole("link").first().innerText(),
      f.project.name,
    );
    await recent.getByRole("link", { name: f.other.name, exact: true }).click();
    await f.page
      .getByRole("heading", { name: f.other.name, exact: true })
      .waitFor();
    assert.equal(
      await recent.getByRole("link").first().innerText(),
      f.other.name,
    );
    await left
      .getByRole("button", {
        name: `プロジェクトメニュー ${f.project.name}`,
        exact: true,
      })
      .click();
    assert.deepEqual(await f.page.getByRole("menuitem").allTextContents(), [
      "詳細を編集",
      "ピン留め",
      "アーカイブ",
    ]);
    await f.page
      .getByRole("menuitem", { name: "ピン留め", exact: true })
      .click();
    await pinned
      .getByRole("link", { name: f.project.name, exact: true })
      .waitFor();
    assert.equal(
      await recent
        .getByRole("link", { name: f.project.name, exact: true })
        .count(),
      0,
    );
    await f.page.reload();
    await pinned
      .getByRole("link", { name: f.project.name, exact: true })
      .waitFor();
    const search = left.getByRole("searchbox", {
      name: "プロジェクトを検索",
      exact: true,
    });
    await search.fill("　研究プロジェクト　");
    assert.deepEqual(await left.getByRole("link").allTextContents(), [
      f.project.name,
    ]);
    await search.fill("ＡＬＰＨＡ");
    await recent
      .getByRole("link", { name: f.other.name, exact: true })
      .waitFor();
    assert.deepEqual(await left.getByRole("link").allTextContents(), [
      f.other.name,
    ]);
    await search.fill("nothing matches");
    await left
      .getByText("該当するプロジェクトはありません", { exact: true })
      .waitFor();
    assert.equal(await left.getByRole("link").count(), 0);
    await search.fill("");
    await left
      .getByRole("button", {
        name: `プロジェクトメニュー ${f.project.name}`,
        exact: true,
      })
      .click();
    await f.page
      .getByRole("menuitem", { name: "ピン留めを解除", exact: true })
      .click();
    await recent
      .getByRole("link", { name: f.project.name, exact: true })
      .waitFor();
    await f.page.reload();
    await recent
      .getByRole("link", { name: f.project.name, exact: true })
      .waitFor();
    assert.equal(await pinned.getByRole("link").count(), 0);
    await f.page.route(`**/api/projects/${f.project.id}/pin`, (route) =>
      route.fulfill({ status: 503, json: { code: "PIN_UNAVAILABLE" } }),
    );
    await left
      .getByRole("button", {
        name: `プロジェクトメニュー ${f.project.name}`,
        exact: true,
      })
      .click();
    await f.page
      .getByRole("menuitem", { name: "ピン留め", exact: true })
      .click();
    const error = f.page
      .getByRole("region", { name: "作業領域", exact: true })
      .getByRole("alert");
    await error.waitFor();
    assert.match(await error.innerText(), /PIN_UNAVAILABLE/);
    assert.equal(await pinned.getByRole("link").count(), 0);
    assert.equal(
      await recent
        .getByRole("link", { name: f.project.name, exact: true })
        .count(),
      1,
    );
  },
);
/** @id TEST-LAYOUT-006 @verifies REQ-LAYOUT-001 REQ-LAYOUT-002 */
test(
  "TEST-LAYOUT-006 project-menu archiving targets the chosen project, including from the home screen",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    await open(f);
    assert.equal(
      await f.page
        .getByRole("region", { name: "作業領域", exact: true })
        .getByRole("button", { name: "アーカイブ", exact: true })
        .count(),
      0,
    );
    async function archiveMenu(name: string) {
      await f.page
        .getByRole("button", {
          name: `プロジェクトメニュー ${name}`,
          exact: true,
        })
        .click();
      await f.page
        .getByRole("menuitem", {
          name: "アーカイブ",
          exact: true,
        })
        .click();
      return f.page.getByRole("dialog", {
        name: "アーカイブを確認",
        exact: true,
      });
    }
    let confirmation = await archiveMenu(f.other.name);
    assert.match(
      await confirmation.locator("pre").innerText(),
      new RegExp(f.other.id),
    );
    assert.ok(
      !(await confirmation.locator("pre").innerText()).includes(f.project.id),
    );
    await confirmation
      .getByRole("button", { name: "拒否", exact: true })
      .click();
    assert.equal(
      (
        await f.admin.query("SELECT status FROM projects WHERE id=$1", [
          f.other.id,
        ])
      ).rows[0].status,
      "active",
    );
    confirmation = await archiveMenu(f.other.name);
    await confirmation
      .getByRole("button", { name: "承認して実行", exact: true })
      .click();
    await confirmation.waitFor({ state: "hidden" });
    assert.equal(
      (
        await f.admin.query("SELECT status FROM projects WHERE id=$1", [
          f.other.id,
        ])
      ).rows[0].status,
      "archived",
    );
    assert.equal(
      (
        await f.admin.query("SELECT status FROM projects WHERE id=$1", [
          f.project.id,
        ])
      ).rows[0].status,
      "active",
    );
    await f.page
      .getByRole("button", {
        name: `プロジェクトメニュー ${f.other.name}`,
        exact: true,
      })
      .click();
    assert.ok(
      await f.page
        .getByRole("menuitem", {
          name: "アーカイブ",
          exact: true,
        })
        .isDisabled(),
    );
    await f.page.keyboard.press("Escape");
    await f.page.goto(f.origin);
    confirmation = await archiveMenu(f.project.name);
    await confirmation
      .getByRole("button", { name: "承認して実行", exact: true })
      .click();
    await confirmation.waitFor({ state: "hidden" });
    assert.equal(
      (
        await f.admin.query("SELECT status FROM projects WHERE id=$1", [
          f.project.id,
        ])
      ).rows[0].status,
      "archived",
    );
  },
);
/** @id TEST-LAYOUT-005 @verifies REQ-LAYOUT-002 REQ-UI-001 */
test(
  "TEST-LAYOUT-005 Notebook tabs retain drafts and guard closing and archiving",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    await open(f);
    const explorer = f.page.getByRole("complementary", {
      name: "ファイルエクスプローラー",
      exact: true,
    });
    await explorer
      .getByRole("button", { name: f.notebook.name, exact: true })
      .click();
    const labTab = f.page.getByRole("tab", {
      name: f.notebook.name,
      exact: true,
    });
    assert.equal(
      await labTab.count(),
      1,
      "each Notebook has its own viewer tab",
    );
    const lab = f.page.getByRole("tabpanel", {
      name: f.notebook.name,
      exact: true,
    });
    const source = lab.getByLabel("ソース Code-A", { exact: true });
    await source.fill("print(700)");
    await f.page.getByRole("tab", { name: "AI Chat", exact: true }).click();
    await labTab.click();
    assert.equal(await source.inputValue(), "print(700)");
    await explorer
      .getByRole("button", { name: f.imported.name, exact: true })
      .click();
    const secondTab = f.page.getByRole("tab", {
      name: f.imported.name,
      exact: true,
    });
    const second = f.page.getByRole("tabpanel", {
      name: f.imported.name,
      exact: true,
    });
    const secondSource = second.getByLabel("ソース Code-A", { exact: true });
    await secondSource.fill("print(800)");
    await labTab.click();
    assert.equal(await source.inputValue(), "print(700)");
    await secondTab.click();
    assert.equal(await secondSource.inputValue(), "print(800)");
    const closeFirst = f.page.getByRole("button", {
      name: `タブを閉じる ${f.notebook.name}`,
      exact: true,
    });
    await closeFirst.click();
    const guard = f.page.getByRole("dialog", {
      name: "未保存の変更",
      exact: true,
    });
    await guard
      .getByRole("button", { name: "編集を続ける", exact: true })
      .click();
    assert.equal(await secondTab.getAttribute("aria-selected"), "true");
    await labTab.click();
    assert.equal(await source.inputValue(), "print(700)");
    await f.page.getByRole("link", { name: f.other.name, exact: true }).click();
    await guard
      .getByRole("button", { name: "編集を続ける", exact: true })
      .click();
    assert.equal(await source.inputValue(), "print(700)");
    await f.page
      .getByRole("button", {
        name: `プロジェクトメニュー ${f.project.name}`,
        exact: true,
      })
      .click();
    await f.page
      .getByRole("menuitem", { name: "アーカイブ", exact: true })
      .click();
    await guard
      .getByRole("button", { name: "変更を破棄", exact: true })
      .click();
    await f.page
      .getByRole("dialog", { name: "アーカイブを確認", exact: true })
      .getByRole("button", { name: "拒否", exact: true })
      .click();
    assert.equal(
      await source.inputValue(),
      "print(700)",
      "rejecting archive retains the draft",
    );
    const saveUrl = `**/api/projects/${f.project.id}/notebooks/${f.notebook.id}`;
    for (const state of ["dirty", "clean"]) {
      const entered = deferred(),
        release = deferred(),
        finished = deferred();
      await f.page.route(saveUrl, async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        entered.resolve();
        await release.promise;
        try {
          await route.continue();
          finished.resolve();
        } catch (error) {
          finished.reject(error);
        }
      });
      try {
        await lab
          .getByRole("button", { name: "Notebook を保存", exact: true })
          .click();
        await bounded(entered.promise, "pending Notebook save");
        assert.ok(
          await closeFirst.isDisabled(),
          "the mutating viewer cannot close",
        );
        const closeSecond = f.page.getByRole("button", {
          name: `タブを閉じる ${f.imported.name}`,
          exact: true,
        });
        assert.ok(
          await closeSecond.isEnabled(),
          "another viewer is not blocked",
        );
        await secondTab.click();
        assert.equal(await secondSource.inputValue(), "print(800)");
        await f.page
          .getByRole("link", { name: f.other.name, exact: true })
          .click();
        assert.equal(
          new URL(f.page.url()).pathname,
          `/projects/${f.project.id}`,
        );
        assert.equal(
          await guard.count(),
          0,
          `${state} busy viewers block departure rather than offer draft discard`,
        );
        await f.page
          .getByRole("button", {
            name: `プロジェクトメニュー ${f.project.name}`,
            exact: true,
          })
          .click();
        assert.ok(
          await f.page
            .getByRole("menuitem", { name: "アーカイブ", exact: true })
            .isDisabled(),
        );
        await f.page.keyboard.press("Escape");
        release.resolve();
        await bounded(finished.promise, "released Notebook save");
        await labTab.click();
        await lab.getByText("保存しました", { exact: true }).waitFor();
      } finally {
        release.resolve();
        await bounded(finished.promise, "pending save cleanup");
        await f.page.unroute(saveUrl);
      }
    }
    await secondTab.click();
    await closeFirst.click();
    assert.equal(
      await labTab.count(),
      0,
      "a clean inactive viewer closes without moving selection",
    );
    assert.equal(await secondTab.getAttribute("aria-selected"), "true");
    await explorer
      .getByRole("button", { name: f.notebook.name, exact: true })
      .click();
    await source.waitFor();
    assert.equal(
      await source.inputValue(),
      "print(700)",
      "reopening loads saved source, not a closed draft",
    );
    await secondTab.click();
    await f.page
      .getByRole("button", {
        name: `タブを閉じる ${f.imported.name}`,
        exact: true,
      })
      .click();
    await guard
      .getByRole("button", { name: "変更を破棄", exact: true })
      .click();
    assert.equal(await secondTab.count(), 0);
    await explorer
      .getByRole("button", { name: f.imported.name, exact: true })
      .click();
    await secondSource.waitFor();
    assert.equal(await secondSource.inputValue(), "print(42)");
    assert.equal(
      (
        await f.admin.query("SELECT document FROM notebooks WHERE id=$1", [
          f.notebook.id,
        ])
      ).rows[0].document.cells[0].source,
      "print(700)",
    );
    await explorer
      .getByLabel("Notebook 名", { exact: true })
      .fill("Lab experiment");
    await explorer
      .getByRole("button", { name: "Notebook を作成", exact: true })
      .click();
    await f.page
      .getByRole("tabpanel")
      .getByRole("heading", { name: "Lab experiment", exact: true })
      .waitFor();
    await explorer
      .getByLabel("ipynb をインポート", { exact: true })
      .setInputFiles({
        name: "lab-import.ipynb",
        mimeType: "application/x-ipynb+json",
        buffer: Buffer.from(JSON.stringify(f.notebook.document)),
      });
    await f.page
      .getByRole("tabpanel")
      .getByRole("heading", { name: "lab-import.ipynb", exact: true })
      .waitFor();
    assert.deepEqual(await f.page.getByRole("tab").allTextContents(), [
      "AI Chat",
      "実験ノート",
      f.notebook.name,
      f.imported.name,
      "Lab experiment",
      "lab-import.ipynb",
    ]);
    await closeFirst.click();
    const reading = deferred(),
      resume = deferred(),
      delivered = deferred();
    let firstRead = true;
    await f.page.route(saveUrl, async (route) => {
      if (route.request().method() !== "GET" || !firstRead)
        return route.continue();
      firstRead = false;
      try {
        const response = await route.fetch();
        reading.resolve();
        await resume.promise;
        await route.fulfill({
          response,
          headers: {
            ...response.headers(),
            "x-qualification-read-generation": "closed",
          },
        });
        delivered.resolve();
      } catch (error) {
        delivered.reject(error);
      }
    });
    try {
      const openOriginal = () =>
        explorer
          .getByRole("button", { name: f.notebook.name, exact: true })
          .click();
      await openOriginal();
      await bounded(reading.promise, "closed generation read");
      assert.ok(await closeFirst.isEnabled(), "read-only loading can close");
      await closeFirst.click();
      await openOriginal();
      await source.waitFor();
      await source.fill("print(901)");
      const chat = f.page.getByRole("tab", {
        name: "AI Chat",
        exact: true,
      });
      await chat.click();
      const response = f.page.waitForResponse(
        (value) =>
          value.headers()["x-qualification-read-generation"] === "closed",
      );
      resume.resolve();
      await bounded(delivered.promise, "closed generation response delivery");
      await (await response).finished();
      await f.page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      assert.equal(
        await chat.getAttribute("aria-selected"),
        "true",
        "a closed generation cannot change the active tab",
      );
      await labTab.click();
      assert.equal(
        await source.inputValue(),
        "print(901)",
        "a closed generation cannot overwrite the reopened viewer draft",
      );
    } finally {
      resume.resolve();
      if (!firstRead)
        await bounded(delivered.promise, "closed generation read cleanup");
      await f.page.unroute(saveUrl);
    }
  },
);
/** @id TEST-LAYOUT-001 @verifies REQ-LAYOUT-001 REQ-LAYOUT-006 */
test(
  "TEST-LAYOUT-001 three panes, project dialogs and bottom settings",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    await open(f);
    const left = f.page.getByRole("complementary", {
      name: "プロジェクト管理",
      exact: true,
    });
    assert.equal(await left.count(), 1);
    const center = f.page.getByRole("region", {
      name: "作業領域",
      exact: true,
    });
    const right = f.page.getByRole("complementary", {
      name: "ファイルエクスプローラー",
      exact: true,
    });
    assert.equal(await center.count(), 1);
    assert.equal(await right.count(), 1);
    const a = await left.boundingBox(),
      b = await center.boundingBox(),
      c = await right.boundingBox();
    assert.ok(a && b && c && a.x < b.x && b.x < c.x);
    const gear = left.getByRole("button", {
      name: "AIRA Nexus の設定",
      exact: true,
    });
    const gearBox = await gear.boundingBox();
    assert.ok(gearBox && a && gearBox.y > a.y + a.height * 0.7);
    const add = left.getByRole("button", {
      name: "プロジェクトを追加",
      exact: true,
    });
    await add.click();
    await f.page
      .getByRole("dialog", { name: "プロジェクトを追加", exact: true })
      .waitFor();
    await f.page.keyboard.press("Escape");
    await f.page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.ok(
      await add.evaluate((element) => element === document.activeElement),
    );
    await add.click();
    const create = f.page.getByRole("dialog", {
      name: "プロジェクトを追加",
      exact: true,
    });
    await create
      .getByLabel("プロジェクト名", { exact: true })
      .fill("Layout created project");
    const initialDescription = Array.from(
      { length: 60 },
      (_, index) => `研究の目的と検証する仮説 ${index + 1}`,
    ).join("\n");
    const description = create.getByLabel("説明", { exact: true });
    const emptyHeight = await description.evaluate(
      (element) => element.clientHeight,
    );
    await description.fill(initialDescription);
    const createScroll = await description.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { height: element.clientHeight, top: element.scrollTop };
    });
    assert.equal(
      createScroll.height,
      emptyHeight,
      "long descriptions must not expand the field",
    );
    assert.ok(
      createScroll.top > 0,
      "long descriptions must scroll inside the creation field",
    );
    await create
      .getByRole("button", { name: "プロジェクトを作成", exact: true })
      .click();
    await f.page
      .getByRole("heading", { name: "Layout created project", exact: true })
      .waitFor();
    await center.getByText(initialDescription, { exact: true }).waitFor();
    await f.page
      .getByRole("button", {
        name: "プロジェクトメニュー Layout created project",
        exact: true,
      })
      .click();
    await f.page
      .getByRole("menuitem", { name: "詳細を編集", exact: true })
      .click();
    const rename = f.page.getByRole("dialog", {
      name: "詳細を編集",
      exact: true,
    });
    assert.equal(
      await rename.getByLabel("説明", { exact: true }).inputValue(),
      initialDescription,
    );
    const editScroll = await rename
      .getByLabel("説明", { exact: true })
      .evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return { height: element.clientHeight, top: element.scrollTop };
      });
    assert.equal(editScroll.height, emptyHeight);
    assert.ok(
      editScroll.top > 0,
      "saved descriptions must scroll inside the editing field",
    );
    await rename
      .getByLabel("プロジェクト名", { exact: true })
      .fill("Layout renamed project");
    await rename
      .getByLabel("説明", { exact: true })
      .fill("Updated research details");
    await rename
      .getByRole("button", { name: "変更を保存", exact: true })
      .click();
    await f.page
      .getByRole("heading", { name: "Layout renamed project", exact: true })
      .waitFor();
    const row = (
      await f.admin.query(
        "SELECT id,chat_id,description,revision FROM projects WHERE name=$1 AND actor='local'",
        ["Layout renamed project"],
      )
    ).rows[0];
    assert.ok(row);
    assert.equal(row.description, "Updated research details");
    await f.page.reload();
    await center
      .getByText("Updated research details", { exact: true })
      .waitFor();
    await add.click();
    assert.equal(
      await create.getByLabel("説明", { exact: true }).inputValue(),
      "",
    );
    await create
      .getByLabel("説明", { exact: true })
      .fill("Cancelled description");
    await create.getByRole("button", { name: "閉じる", exact: true }).click();
    await add.click();
    assert.equal(
      await create.getByLabel("説明", { exact: true }).inputValue(),
      "",
    );
    await create.getByRole("button", { name: "閉じる", exact: true }).click();
    await f.page
      .getByRole("button", {
        name: "プロジェクトメニュー Layout renamed project",
        exact: true,
      })
      .click();
    assert.deepEqual(await f.page.getByRole("menuitem").allTextContents(), [
      "詳細を編集",
      "ピン留め",
      "アーカイブ",
    ]);
    await f.page.keyboard.press("Escape");
    assert.equal(
      (
        await f.admin.query("SELECT hidden_at FROM projects WHERE id=$1", [
          row.id,
        ])
      ).rows[0].hidden_at,
      null,
    );
    const hidden = await f.page.request.post(
      `${f.origin}/api/projects/${row.id}/hide`,
      {
        data: { revision: row.revision },
      },
    );
    assert.equal(hidden.status(), 200);
    await f.page.goto(f.origin);
    await f.page
      .getByRole("link", { name: "Layout renamed project", exact: true })
      .waitFor({ state: "hidden" });
    const retained = (
      await f.admin.query(
        "SELECT chat_id,hidden_at FROM projects WHERE id=$1",
        [row.id],
      )
    ).rows[0];
    assert.equal(retained.chat_id, row.chat_id);
    assert.ok(retained.hidden_at);
    await f.page
      .getByRole("button", { name: "AIRA Nexus の設定", exact: true })
      .click();
    const settings = f.page.getByRole("dialog", {
      name: "AIRA Nexus の設定",
      exact: true,
    });
    const restore = settings.getByRole("button", {
      name: "復元 Layout renamed project",
      exact: true,
    });
    await restore.click();
    await restore.waitFor({ state: "hidden" });
    await settings.getByRole("button", { name: "閉じる", exact: true }).click();
    await f.page
      .getByRole("link", { name: "Layout renamed project", exact: true })
      .waitFor();
    assert.equal(
      (
        await f.admin.query("SELECT chat_id FROM projects WHERE id=$1", [
          row.id,
        ])
      ).rows[0].chat_id,
      row.chat_id,
    );
  },
);
/** @id TEST-LAYOUT-002 @verifies REQ-LAYOUT-002 */
test(
  "TEST-LAYOUT-002 fixed AI Chat and individually reorderable scoped Notebook/file tabs",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    const upload = await f.page.request.post(
      `${f.origin}/api/projects/${f.project.id}/files?name=second.txt`,
      { headers: { "Content-Type": "text/plain" }, data: "Second file" },
    );
    assert.equal(upload.status(), 201);
    await open(f);
    assert.deepEqual(await f.page.getByRole("tab").allTextContents(), [
      "AI Chat",
      "実験ノート",
    ]);
    const right = f.page.getByRole("complementary", {
      name: "ファイルエクスプローラー",
      exact: true,
    });
    await right.getByRole("button", { name: f.file.name, exact: true }).click();
    await f.page.getByRole("tab", { name: f.file.name, exact: true }).waitFor();
    await f.page
      .getByRole("tabpanel")
      .getByText(/AUROC=0.83/)
      .waitFor();
    await right
      .getByRole("button", { name: f.notebook.name, exact: true })
      .click();
    await f.page
      .getByRole("tabpanel")
      .getByLabel("ソース Code-A", { exact: true })
      .waitFor();
    await right.getByRole("button", { name: f.file.name, exact: true }).click();
    assert.equal(await f.page.getByRole("tab").count(), 4);
    const chatTab = f.page.getByRole("tab", { name: "AI Chat", exact: true });
    const labTab = f.page.getByRole("tab", {
      name: f.notebook.name,
      exact: true,
    });
    const fixedOrder = ["AI Chat", "実験ノート", f.file.name, f.notebook.name];
    for (const tab of [chatTab]) {
      assert.notEqual(await tab.getAttribute("draggable"), "true");
      for (const key of ["Alt+ArrowLeft", "Alt+ArrowRight", "Delete"]) {
        await tab.press(key);
        assert.deepEqual(
          await f.page.getByRole("tab").allTextContents(),
          fixedOrder,
        );
      }
    }
    await chatTab.dragTo(labTab);
    assert.deepEqual(
      await f.page.getByRole("tab").allTextContents(),
      fixedOrder,
    );
    const chatBox = await chatTab.boundingBox(),
      labBox = await labTab.boundingBox();
    assert.ok(chatBox && labBox && chatBox.x < labBox.x);
    await right
      .getByRole("button", { name: "second.txt", exact: true })
      .click();
    const fileTab = f.page.getByRole("tab", { name: f.file.name, exact: true });
    const secondTab = f.page.getByRole("tab", {
      name: "second.txt",
      exact: true,
    });
    await secondTab.dragTo(fileTab);
    assert.deepEqual(await f.page.getByRole("tab").allTextContents(), [
      "AI Chat",
      "実験ノート",
      "second.txt",
      f.file.name,
      f.notebook.name,
    ]);
    await secondTab.press("Alt+ArrowRight");
    assert.deepEqual(await f.page.getByRole("tab").allTextContents(), [
      "AI Chat",
      "実験ノート",
      f.file.name,
      "second.txt",
      f.notebook.name,
    ]);
    await labTab.press("Alt+ArrowLeft");
    await labTab.press("Alt+ArrowLeft");
    await labTab.press("Alt+ArrowLeft");
    assert.deepEqual(await f.page.getByRole("tab").allTextContents(), [
      "AI Chat",
      "実験ノート",
      f.notebook.name,
      f.file.name,
      "second.txt",
    ]);
    await labTab.dragTo(secondTab);
    assert.deepEqual(await f.page.getByRole("tab").allTextContents(), [
      "AI Chat",
      "実験ノート",
      f.file.name,
      "second.txt",
      f.notebook.name,
    ]);
    await right
      .getByRole("button", { name: f.notebook.name, exact: true })
      .click();
    assert.equal(
      await f.page.getByRole("tab").count(),
      5,
      "Notebook opens deduplicate",
    );
    await labTab.press("Delete");
    assert.equal(
      await secondTab.getAttribute("aria-selected"),
      "true",
      "active close selects its adjacent viewer",
    );
    for (const label of ["AI Chat", "実験ノート"]) {
      assert.equal(
        await f.page
          .getByRole("button", { name: `タブを閉じる ${label}`, exact: true })
          .count(),
        0,
      );
    }
    await f.page
      .getByRole("button", { name: `タブを閉じる ${f.file.name}`, exact: true })
      .click();
    const retained = await f.page.request.get(
      `${f.origin}/api/projects/${f.project.id}/files/${f.file.id}/download`,
    );
    assert.equal(retained.status(), 200);
    assert.equal(
      createHash("sha256")
        .update(await retained.body())
        .digest("hex"),
      f.file.sha256,
    );
    const entered = deferred(),
      release = deferred(),
      finished = deferred(),
      settled = deferred();
    let intercepted = false;
    const url = `**/api/projects/${f.project.id}/files/${f.file.id}/preview`;
    const completed = (request: BrowserRequest) => {
      if (request.url().endsWith(`/files/${f.file.id}/preview`))
        settled.resolve();
    };
    f.page.on("requestfinished", completed);
    f.page.on("requestfailed", completed);
    await f.page.route(url, async (route) => {
      intercepted = true;
      entered.resolve();
      await release.promise;
      try {
        await route.continue();
        finished.resolve();
      } catch (error) {
        if (route.request().failure()) finished.resolve();
        else finished.reject(error);
      }
    });
    try {
      await right
        .getByRole("button", { name: f.file.name, exact: true })
        .click();
      await bounded(entered.promise, "delayed old-project preview");
      await f.page
        .getByRole("link", { name: f.other.name, exact: true })
        .click();
      await f.page
        .getByRole("heading", { name: f.other.name, exact: true })
        .waitFor();
      release.resolve();
      await bounded(settled.promise, "old preview finished or cancelled");
      await bounded(finished.promise, "released old-project preview");
      await f.page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.deepEqual(await f.page.getByRole("tab").allTextContents(), [
        "AI Chat",
        "実験ノート",
      ]);
      assert.equal(await f.page.getByText(/AUROC=0.83|print\(42\)/).count(), 0);
    } finally {
      release.resolve();
      if (intercepted) await bounded(finished.promise, "preview cleanup");
      await f.page.unroute(url);
      f.page.off("requestfinished", completed);
      f.page.off("requestfailed", completed);
    }
  },
);
/** @id TEST-LAYOUT-003 @verifies REQ-LAYOUT-003 */
test(
  "TEST-LAYOUT-003 browser-persistent Light/Dark and Japanese/English",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    const external: string[] = [];
    f.page.on("request", (request) => {
      if (
        /^https?:/.test(request.url()) &&
        new URL(request.url()).origin !== f.origin
      )
        external.push(request.url());
    });
    await open(f);
    assert.equal(
      await f.page
        .getByRole("tab", { name: "実験ノート", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await f.page
        .getByRole("tab", { name: "電子実験ノート", exact: true })
        .count(),
      0,
    );
    await f.page.getByRole("heading", { name: "ipynb", exact: true }).waitFor();
    assert.equal(
      await f.page
        .getByRole("button", { name: "AIRA Nexus の設定", exact: true })
        .count(),
      1,
    );
    const light = await f.page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    await f.page
      .getByRole("button", { name: "AIRA Nexus の設定", exact: true })
      .click();
    let settings = f.page.getByRole("dialog", {
      name: "AIRA Nexus の設定",
      exact: true,
    });
    await settings.getByLabel("テーマ", { exact: true }).selectOption("dark");
    await settings.getByLabel("表示言語", { exact: true }).selectOption("en");
    settings = f.page.getByRole("dialog", {
      name: "AIRA Nexus settings",
      exact: true,
    });
    assert.equal(
      await f.page.getByRole("tab", { name: "ELN", exact: true }).count(),
      0,
    );
    assert.equal(
      await f.page.locator("#explorer-pane .notebook-manager > h2").innerText(),
      "ipynb",
    );
    assert.equal(
      await settings
        .getByRole("heading", { name: "Diagnostics", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await settings
        .getByRole("button", { name: "Run diagnostics", exact: true })
        .count(),
      1,
    );
    await settings
      .getByText("These selections are not applied to chat.", { exact: true })
      .waitFor();
    await settings
      .getByLabel("Search catalog", { exact: true })
      .fill("co-scientist-academic-writing");
    await settings
      .getByRole("checkbox", {
        name: "co-scientist-academic-writing",
        exact: true,
      })
      .check();
    await settings
      .getByLabel("Search catalog", { exact: true })
      .fill("ToolUniverse");
    await settings
      .getByRole("checkbox", { name: "ToolUniverse", exact: true })
      .check();
    await settings
      .getByRole("button", { name: "Save selections", exact: true })
      .click();
    await settings.getByText("Selections saved", { exact: true }).waitFor();
    assert.equal(
      await f.page.locator("html").getAttribute("data-theme"),
      "dark",
    );
    assert.equal(await f.page.locator("html").getAttribute("lang"), "en");
    assert.notEqual(
      await f.page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
      light,
    );
    assert.equal(await settings.locator('input[type="password"]').count(), 0);
    const saved = await (
      await f.page.request.get(
        `${f.origin}/api/projects/${f.project.id}/integrations`,
      )
    ).json();
    assert.deepEqual(saved.selections, {
      agents: [],
      skills: ["co-scientist-academic-writing"],
      mcp: ["tooluniverse"],
    });
    assert.equal(saved.appliedToChat, false);
    await f.page.reload();
    await f.page.getByRole("tab", { name: "Lab Note", exact: true }).waitFor();
    await f.page.getByRole("heading", { name: "ipynb", exact: true }).waitFor();
    await f.page
      .getByRole("button", { name: "AIRA Nexus settings", exact: true })
      .click();
    settings = f.page.getByRole("dialog", {
      name: "AIRA Nexus settings",
      exact: true,
    });
    assert.equal(
      await settings.getByLabel("Theme", { exact: true }).inputValue(),
      "dark",
    );
    await settings
      .getByLabel("Search catalog", { exact: true })
      .fill("ToolUniverse");
    assert.ok(
      await settings
        .getByRole("checkbox", { name: "ToolUniverse", exact: true })
        .isChecked(),
    );
    await settings
      .getByRole("checkbox", { name: "ToolUniverse", exact: true })
      .uncheck();
    await f.page.route(
      `**/api/projects/${f.project.id}/integrations`,
      async (route) => {
        if (route.request().method() === "PUT")
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: '{"code":"STALE_INTEGRATION_REVISION"}',
          });
        else await route.continue();
      },
    );
    await settings
      .getByRole("button", { name: "Save selections", exact: true })
      .click();
    await settings.getByRole("alert").waitFor();
    assert.match(
      await settings.getByRole("alert").innerText(),
      /changed|reload/i,
    );
    assert.match(
      await settings.getByRole("alert").innerText(),
      /STALE_INTEGRATION_REVISION/,
    );
    await settings.getByLabel("Language", { exact: true }).selectOption("ja");
    settings = f.page.getByRole("dialog", {
      name: "AIRA Nexus の設定",
      exact: true,
    });
    assert.equal(
      await f.page
        .getByRole("tab", { name: "電子実験ノート", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await f.page.locator("#explorer-pane .notebook-manager > h2").innerText(),
      "ipynb",
    );
    assert.match(
      await settings.getByRole("alert").innerText(),
      /更新|再読み込み/,
    );
    assert.deepEqual(
      (
        await f.admin.query("SELECT document FROM notebooks WHERE id=$1", [
          f.notebook.id,
        ])
      ).rows[0].document,
      f.notebook.document,
    );
    assert.equal(
      (
        await f.page.request.get(`${f.origin}/api/projects/${f.project.id}`)
      ).status(),
      200,
    );
    await settings.getByLabel("表示言語", { exact: true }).selectOption("en");
    settings = f.page.getByRole("dialog", {
      name: "AIRA Nexus settings",
      exact: true,
    });
    await settings.getByLabel("Search catalog", { exact: true }).fill("");
    assert.equal(
      await settings
        .getByRole("group", { name: "Skills", exact: true })
        .getByRole("checkbox")
        .count(),
      203,
    );
    assert.equal(
      await settings
        .getByRole("group", { name: "Agents", exact: true })
        .getByRole("checkbox")
        .count(),
      0,
    );
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    assert.equal(
      await f.page
        .getByRole("complementary", { name: "Project management", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await f.page
        .getByRole("complementary", { name: "File explorer", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await f.page.getByLabel("Upload file", { exact: true }).count(),
      1,
    );
    await f.page
      .getByRole("button", { name: "Add project", exact: true })
      .click();
    const create = f.page.getByRole("dialog", {
      name: "Add project",
      exact: true,
    });
    assert.equal(
      await create.getByLabel("Project name", { exact: true }).count(),
      1,
    );
    assert.equal(
      await create.getByLabel("Description", { exact: true }).count(),
      1,
    );
    await create.getByRole("button", { name: "Close", exact: true }).click();
    await f.page
      .getByRole("button", {
        name: `Project menu ${f.project.name}`,
        exact: true,
      })
      .click();
    assert.deepEqual(await f.page.getByRole("menuitem").allTextContents(), [
      "Edit details",
      "Pin",
      "Archive",
    ]);
    assert.equal(
      await f.page
        .getByRole("searchbox", { name: "Search projects", exact: true })
        .count(),
      1,
    );
    for (const name of ["Pinned", "Recent projects"])
      assert.equal(
        await f.page.getByRole("region", { name, exact: true }).count(),
        1,
      );
    await f.page
      .getByRole("menuitem", { name: "Edit details", exact: true })
      .click();
    await f.page
      .getByRole("dialog", { name: "Edit details", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await f.page
      .getByRole("button", {
        name: `Project menu ${f.project.name}`,
        exact: true,
      })
      .click();
    await f.page
      .getByRole("menuitem", { name: "Archive", exact: true })
      .click();
    const archive = f.page.getByRole("dialog", {
      name: "Confirm archive",
      exact: true,
    });
    assert.equal(
      await archive
        .getByRole("button", { name: "Approve and proceed", exact: true })
        .count(),
      1,
    );
    await archive.getByRole("button", { name: "Reject", exact: true }).click();
    await f.page
      .getByRole("complementary", { name: "File explorer", exact: true })
      .getByRole("button", { name: f.notebook.name, exact: true })
      .click();
    assert.equal(
      await f.page
        .getByRole("tabpanel")
        .getByLabel("Source Code-A", { exact: true })
        .inputValue(),
      "print(42)",
    );
    assert.equal(
      await f.page
        .getByRole("button", {
          name: `Close tab ${f.notebook.name}`,
          exact: true,
        })
        .count(),
      1,
    );
    await f.page.getByRole("tab", { name: "AI Chat", exact: true }).click();
    assert.equal(
      await f.page.getByLabel("Message", { exact: true }).count(),
      1,
    );
    assert.equal(
      await f.page
        .getByRole("button", { name: "Review outbound content", exact: true })
        .count(),
      1,
    );
    await f.page
      .getByRole("complementary", { name: "File explorer", exact: true })
      .getByRole("button", { name: f.file.name, exact: true })
      .click();
    await f.page
      .getByRole("tabpanel")
      .getByText(/AUROC=0.83/)
      .waitFor();
    await f.page.evaluate(() =>
      localStorage.setItem(
        "aira-nexus.appearance",
        '{"theme":"system","locale":"xx"}',
      ),
    );
    await f.page.reload();
    await f.page
      .getByRole("heading", { name: f.project.name, exact: true })
      .waitFor();
    assert.equal(
      await f.page.locator("html").getAttribute("data-theme"),
      "light",
    );
    assert.equal(await f.page.locator("html").getAttribute("lang"), "ja");
    const preferenceAlert = f.page
      .getByRole("region", { name: "作業領域", exact: true })
      .getByRole("alert");
    assert.equal(await preferenceAlert.count(), 1);
    assert.match(
      await preferenceAlert.innerText(),
      /標準設定|PREFERENCES_INVALID_OR_UNAVAILABLE/,
    );
    await f.page
      .getByRole("button", { name: "AIRA Nexus の設定", exact: true })
      .click();
    settings = f.page.getByRole("dialog", {
      name: "AIRA Nexus の設定",
      exact: true,
    });
    await settings.getByLabel("テーマ", { exact: true }).selectOption("dark");
    await settings.getByLabel("表示言語", { exact: true }).selectOption("en");
    await f.page
      .getByRole("dialog", { name: "AIRA Nexus settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    assert.equal(
      await f.page
        .getByRole("region", { name: "Workspace", exact: true })
        .getByRole("alert")
        .count(),
      0,
    );
    assert.deepEqual(
      external,
      [],
      "opening/selecting catalog performs no upstream browser request",
    );
  },
);
/** @id TEST-LAYOUT-004 @verifies REQ-LAYOUT-004 */
test(
  "TEST-LAYOUT-004 mobile keyboard and preserved research safeguards",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    t.after(() => f.close());
    await f.page.setViewportSize({ width: 390, height: 844 });
    await open(f);
    assert.deepEqual(await f.page.getByRole("tab").allTextContents(), [
      "AI Chat",
      "実験ノート",
    ]);
    const projects = f.page.getByRole("button", {
      name: "プロジェクトペインを切り替え",
      exact: true,
    });
    const explorer = f.page.getByRole("button", {
      name: "エクスプローラーを切り替え",
      exact: true,
    });
    assert.equal(await projects.count(), 1);
    assert.equal(await explorer.count(), 1);
    await explorer.click();
    await f.page
      .getByRole("complementary", {
        name: "ファイルエクスプローラー",
        exact: true,
      })
      .getByRole("button", { name: f.notebook.name, exact: true })
      .click();
    const source = f.page
      .getByRole("tabpanel")
      .getByLabel("ソース Code-A", { exact: true });
    await source.waitFor();
    const entered = deferred(),
      release = deferred(),
      finished = deferred();
    const notebookPath = `/api/projects/${f.project.id}/notebooks/${f.notebook.id}`;
    const paused = `**${notebookPath}`;
    const otherReads = [
      `${notebookPath}/imported`,
      `${notebookPath}/history`,
      `/api/projects/${f.project.id}/runtime/${f.notebook.id}`,
    ].map((path) =>
      f.page.waitForResponse(
        (response) =>
          response.url().endsWith(path) &&
          response.request().method() === "GET",
      ),
    );
    let intercepted = false;
    await f.page.route(paused, async (route) => {
      if (route.request().method() !== "GET" || intercepted) {
        await route.continue();
        return;
      }
      intercepted = true;
      entered.resolve();
      await release.promise;
      try {
        await route.continue();
        finished.resolve();
      } catch (error) {
        finished.reject(error);
      }
    });
    try {
      await explorer.click();
      await f.page
        .getByLabel("ファイルをアップロード", { exact: true })
        .setInputFiles({
          name: "refresh-control.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Background refresh control"),
        });
      await bounded(entered.promise, "background notebook reload");
      for (const response of await Promise.all(otherReads))
        assert.equal(await response.finished(), null);
      await explorer.click();
      await source.fill("print(777)");
      const completed = f.page.waitForResponse(
        (response) =>
          response.url().endsWith(notebookPath) &&
          response.request().method() === "GET",
      );
      release.resolve();
      assert.equal(await (await completed).finished(), null);
      await bounded(finished.promise, "released notebook reload");
      await f.page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.equal(
        await source.inputValue(),
        "print(777)",
        "background reads must not replace edits made in flight",
      );
    } finally {
      release.resolve();
      if (intercepted)
        await bounded(finished.promise, "notebook reload cleanup");
      await f.page.unroute(paused);
    }
    await f.page
      .getByRole("button", {
        name: `タブを閉じる ${f.notebook.name}`,
        exact: true,
      })
      .click();
    let guard = f.page.getByRole("dialog", {
      name: "未保存の変更",
      exact: true,
    });
    await guard
      .getByRole("button", { name: "編集を続ける", exact: true })
      .click();
    assert.equal(await source.inputValue(), "print(777)");
    await projects.click();
    await f.page
      .getByRole("button", { name: "プロジェクトを追加", exact: true })
      .click();
    await f.page
      .getByRole("dialog", { name: "未保存の変更", exact: true })
      .getByRole("button", { name: "変更を破棄", exact: true })
      .click();
    await f.page
      .getByRole("dialog", { name: "プロジェクトを追加", exact: true })
      .getByRole("button", { name: "閉じる", exact: true })
      .click();
    assert.equal(
      await source.count(),
      1,
      "cancelling creation must retain the dirty viewer",
    );
    assert.equal(await source.inputValue(), "print(777)");
    await f.page
      .getByRole("button", {
        name: `プロジェクトメニュー ${f.project.name}`,
        exact: true,
      })
      .click();
    await f.page
      .getByRole("menuitem", { name: "アーカイブ", exact: true })
      .click();
    await f.page
      .getByRole("dialog", { name: "未保存の変更", exact: true })
      .getByRole("button", { name: "変更を破棄", exact: true })
      .click();
    await f.page
      .getByRole("dialog", { name: "アーカイブを確認", exact: true })
      .getByRole("button", { name: "拒否", exact: true })
      .click();
    assert.equal(
      await source.count(),
      1,
      "rejecting archive must retain the dirty viewer",
    );
    assert.equal(await source.inputValue(), "print(777)");
    await projects.click();
    await projects.click();
    await f.page.getByRole("link", { name: f.other.name, exact: true }).click();
    guard = f.page.getByRole("dialog", { name: "未保存の変更", exact: true });
    await guard
      .getByRole("button", { name: "変更を破棄", exact: true })
      .click();
    await f.page
      .getByRole("heading", { name: f.other.name, exact: true })
      .waitFor();
    assert.equal(
      (
        await f.admin.query("SELECT document FROM notebooks WHERE id=$1", [
          f.notebook.id,
        ])
      ).rows[0].document.cells[0].source,
      "print(42)",
    );
    assert.ok(
      await f.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await projects.click();
    await f.page
      .getByRole("link", { name: f.project.name, exact: true })
      .click();
    await f.page
      .getByRole("heading", { name: f.project.name, exact: true })
      .waitFor();
    await f.page
      .getByLabel("メッセージ", { exact: true })
      .fill("Fresh mobile disclosure");
    await f.page
      .getByRole("button", { name: "送信内容を確認", exact: true })
      .click();
    await f.page
      .getByRole("dialog")
      .getByRole("button", { name: "拒否", exact: true })
      .click();
    assert.equal(
      (await f.admin.query("SELECT count(*)::integer AS n FROM chat_turns"))
        .rows[0].n,
      0,
    );
    await projects.click();
    const menu = f.page.getByRole("button", {
      name: `プロジェクトメニュー ${f.project.name}`,
      exact: true,
    });
    await menu.focus();
    await menu.press("Enter");
    await f.page.keyboard.press("ArrowDown");
    await f.page.keyboard.press("Escape");
    assert.ok(
      await menu.evaluate((element) => element === document.activeElement),
    );
    await f.page
      .getByRole("link", { name: f.archived.name, exact: true })
      .click();
    await f.page
      .getByRole("heading", { name: f.archived.name, exact: true })
      .waitFor();
    await f.page
      .getByText("アーカイブ済み・読み取り専用", { exact: true })
      .waitFor();
    await explorer.click();
    assert.ok(
      await f.page
        .getByLabel("ファイルをアップロード", { exact: true })
        .isDisabled(),
    );
    assert.ok(
      await f.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  },
);
