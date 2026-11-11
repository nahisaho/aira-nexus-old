import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceFixture } from "./helpers/workspace";
import {
  markdownBody,
  updateMarkdownMetadata,
} from "../src/lib/markdown-metadata";
import type { Notebook } from "../src/server/notebooks";

/** @id TEST-LAYOUT-012 @verifies REQ-MARKDOWN-004 REQ-MARKDOWN-005 */
test(
  "TEST-LAYOUT-012 journal Text and direct rich editing preserve source, selection and guards in Chromium",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture(true);
    const releases: (() => void)[] = [];
    t.after(async () => {
      for (const release of releases) release();
      await f.close();
    });
    const root = `/api/projects/${f.project.id}`;
    async function current(): Promise<Notebook> {
      const response = await f.page.request.get(`${f.origin}${root}/lab-note`);
      assert.equal(response.status(), 200);
      return response.json();
    }
    await f.page.goto(`${f.origin}/projects/${f.project.id}`);
    await f.page.locator("#tab-lab-note").click();
    const panel = f.page.locator("#panel-lab-note");
    await panel.locator(".notebook-document").waitFor();
    assert.equal(
      await panel
        .getByRole("button", { name: "Text表記", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await panel
        .getByRole("button", { name: "Markdownレンダリング表記", exact: true })
        .count(),
      1,
    );
    const text = panel.getByRole("button", { name: "Text表記", exact: true });
    const rich = panel.getByRole("button", {
      name: "Markdownレンダリング表記",
      exact: true,
    });
    const timestamp = panel.getByRole("button", {
      name: "タイムスタンプを挿入",
      exact: true,
      includeHidden: true,
    });
    const save = panel.getByRole("button", {
      name: "Notebook を保存",
      exact: true,
    });
    const editor = (id: string) =>
      panel.locator(`[data-journal-cell="${id}"] .ProseMirror`);
    const before = await current();
    assert.equal(before.document.cells.length, 0);
    const now = Date.now();
    await timestamp.click();
    assert.equal(await panel.locator("[data-journal-cell]").count(), 1);
    const inserted = await panel
      .locator("[data-journal-cell] .ProseMirror")
      .textContent();
    assert.ok(
      inserted &&
        Date.parse(inserted) >= now &&
        Date.parse(inserted) <= Date.now(),
    );
    assert.equal(
      (await current()).revision,
      before.revision,
      "draft timestamp must not auto-save",
    );
    async function saveDraft() {
      await save.click();
      await panel.getByText("保存しました", { exact: true }).waitFor();
    }
    await saveDraft();
    const persisted = await current();
    const tracked = updateMarkdownMetadata(
      "\uFEFF# Initial\n\nbody",
      "Fixture",
      "2026-11-11T00:00:00.000Z",
    );
    const trackedPrefix = tracked.slice(
      0,
      tracked.length - markdownBody(tracked).length,
    );
    const cells = [
      { id: "Journal-A", cell_type: "markdown", source: tracked, metadata: {} },
      {
        id: "Journal-B",
        cell_type: "markdown",
        source: "second cell",
        metadata: {},
      },
    ];
    const seeded = await f.page.request.put(
      `${f.origin}${root}/notebooks/${persisted.id}`,
      {
        data: {
          revision: persisted.revision,
          document: { ...persisted.document, cells },
          editorName: "Fixture",
        },
      },
    );
    assert.equal(seeded.status(), 200);
    await f.page.reload();
    await f.page.locator("#tab-lab-note").click();
    await editor("Journal-A").waitFor();
    const revision = (await current()).revision;
    for (let i = 0; i < 3; i++) {
      await text.click();
      assert.equal(await editor("Journal-A").textContent(), tracked);
      await rich.click();
      assert.equal(
        await editor("Journal-A").locator("h1").textContent(),
        "Initial",
      );
    }
    assert.equal((await current()).revision, revision);
    assert.equal((await current()).document.cells[0].source, tracked);
    async function setSource(source: string, id = "Journal-A") {
      await text.click();
      await editor(id).fill((id === "Journal-A" ? trackedPrefix : "") + source);
      await rich.click();
    }
    async function select(id: string, range: boolean) {
      await editor(id).evaluate((element, range) => {
        element.focus();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        if (!range)
          for (let next = walker.nextNode(); next; next = walker.nextNode())
            node = next;
        if (!node) throw new Error("TEST_EDITOR_TEXT_REQUIRED");
        const selection = window.getSelection();
        if (!selection) throw new Error("TEST_SELECTION_REQUIRED");
        const value = document.createRange();
        value.setStart(node, range ? 0 : node.textContent!.length);
        value.setEnd(node, node.textContent!.length);
        selection.removeAllRanges();
        selection.addRange(value);
        document.dispatchEvent(new Event("selectionchange"));
      }, range);
    }
    for (const [label, tag] of [
      ["太字", "strong"],
      ["斜体", "em"],
      ["打消し線", "s"],
    ] as const) {
      for (const range of [false, true]) {
        await setSource("hello");
        await select("Journal-A", range);
        await panel.getByRole("button", { name: label, exact: true }).click();
        if (!range) await f.page.keyboard.type("X");
        assert.equal(await editor("Journal-A").locator(tag).count(), 1);
        assert.equal(
          await editor("Journal-A").locator(tag).textContent(),
          range ? "hello" : "X",
        );
      }
    }
    for (const level of [1, 2, 3]) {
      for (const range of [false, true]) {
        await setSource("heading");
        await select("Journal-A", range);
        await panel
          .getByRole("button", { name: `見出し${level}`, exact: true })
          .click();
        assert.equal(await editor("Journal-A").locator(`h${level}`).count(), 1);
        assert.equal(
          await editor("Journal-A").locator(`h${level}`).textContent(),
          "heading",
        );
      }
    }
    for (const literal of ["snake_case_name", "実験_値_記録"]) {
      await setSource("");
      await editor("Journal-A").focus();
      await f.page.keyboard.type(literal);
      assert.equal(await editor("Journal-A").locator("em").count(), 0);
      assert.equal(await editor("Journal-A").textContent(), literal);
    }
    await setSource("");
    await editor("Journal-A").focus();
    await f.page.keyboard.type("# Live **bold** and ~~gone~~");
    assert.equal(await editor("Journal-A").locator("h1").count(), 1);
    assert.equal(
      await editor("Journal-A").locator("strong").textContent(),
      "bold",
    );
    assert.equal(await editor("Journal-A").locator("s").textContent(), "gone");
    await text.click();
    assert.match(
      markdownBody((await editor("Journal-A").textContent())!),
      /^# Live \*\*bold\*\* and ~~gone~~/,
    );
    await rich.click();
    const cdp = await f.page.context().newCDPSession(f.page);
    await select("Journal-A", false);
    await cdp.send("Input.imeSetComposition", {
      text: "実験",
      selectionStart: 2,
      selectionEnd: 2,
    });
    assert.equal(await text.isDisabled(), true);
    await cdp.send("Input.insertText", { text: "実験" });
    await cdp.detach();
    await text.waitFor({ state: "visible" });
    await f.page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll("button")).find(
          (b) => b.textContent === "Text表記",
        )?.disabled,
    );
    assert.match((await editor("Journal-A").textContent())!, /実験$/);
    const firstSource = (await editor("Journal-A").textContent())!;
    await setSource("second", "Journal-B");
    await select("Journal-B", true);
    const lower = Date.now();
    await timestamp.click();
    const second = (await editor("Journal-B").textContent())!;
    assert.ok(Date.parse(second) >= lower && Date.parse(second) <= Date.now());
    assert.equal(await editor("Journal-A").textContent(), firstSource);
    await setSource("undoable");
    await select("Journal-A", false);
    await f.page.keyboard.type("X");
    await f.page.keyboard.press("Control+z");
    assert.equal(await editor("Journal-A").textContent(), "undoable");
    await f.page.keyboard.press("Control+Shift+z");
    assert.equal(await editor("Journal-A").textContent(), "undoableX");
    await text.click();
    const literalBefore = await editor("Journal-A").textContent();
    await select("Journal-A", false);
    await timestamp.click();
    assert.notEqual(await editor("Journal-A").textContent(), literalBefore);
    await f.page.keyboard.press("Control+z");
    assert.equal(await editor("Journal-A").textContent(), literalBefore);
    await f.page.keyboard.press("Control+Shift+z");
    assert.notEqual(await editor("Journal-A").textContent(), literalBefore);
    const mermaid = "```mermaid\nflowchart LR\n A-->B\n```";
    await setSource(mermaid);
    await editor("Journal-A").focus();
    await timestamp.click();
    await text.click();
    const withAtom = (await editor("Journal-A").textContent())!;
    assert.ok(withAtom.includes(mermaid));
    assert.match(withAtom, /\d{4}-\d\d-\d\dT/);
    const invalid = "---\nx: [\n---\nbody";
    await editor("Journal-A").fill(invalid);
    await rich.click();
    await panel
      .getByRole("alert")
      .filter({ hasText: "INVALID_MARKDOWN_FRONTMATTER" })
      .waitFor();
    await text.click();
    assert.equal(await editor("Journal-A").textContent(), invalid);
    await editor("Journal-A").fill("safe");
    await rich.click();
    for (const [kind, value, code] of [
      ["text/plain", "x".repeat(65537), "JOURNAL_SOURCE_BUDGET_EXCEEDED"],
      [
        "text/html",
        "<b>unsupported HTML-only paste</b>",
        "JOURNAL_PLAIN_TEXT_REQUIRED",
      ],
    ]) {
      await editor("Journal-A").evaluate(
        (element, { kind, value }) => {
          element.focus();
          const data = new DataTransfer();
          data.setData(kind, value);
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: data,
            }),
          );
        },
        { kind, value },
      );
      await panel.getByRole("alert").filter({ hasText: code }).waitFor();
      assert.equal(await editor("Journal-A").textContent(), "safe");
    }
    const foreign: string[] = [];
    f.page.on("request", (r) => {
      if (new URL(r.url()).origin !== f.origin) foreign.push(r.url());
    });
    await rich.click();
    await editor("Journal-A").evaluate((element) => {
      element.focus();
      const data = new DataTransfer();
      const value =
        '<img src="https://example.invalid/x.png" onerror="window.__journalAttack=1">';
      data.setData("text/html", value);
      data.setData("text/plain", value);
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    });
    assert.equal(
      await editor("Journal-A").locator("img[src],script").count(),
      0,
    );
    assert.equal(
      await f.page.evaluate(() => Reflect.get(window, "__journalAttack")),
      undefined,
    );
    await setSource(
      "![remote](https://example.invalid/no.png)\n\n[remote](https://example.invalid/)",
    );
    assert.equal(
      await editor("Journal-A")
        .locator('img[src^="http"],a[href^="http"]')
        .count(),
      0,
    );
    assert.deepEqual(foreign, []);
    await setSource("final **saved**");
    await saveDraft();
    const saved = await current();
    assert.equal(saved.document.cells[0].id, "Journal-A");
    assert.ok(saved.document.cells[0].source.startsWith("\uFEFF"));
    assert.match(
      saved.document.cells[0].source,
      /created_at: 2026-11-11T00:00:00.000Z/,
    );
    assert.match(saved.document.cells[0].source, /final \*\*saved\*\*/);
    const historyResponse = await f.page.request.get(
      `${f.origin}${root}/notebooks/${saved.id}/versions?limit=50`,
    );
    assert.equal(historyResponse.status(), 200);
    await f.page.reload();
    await f.page.locator("#tab-lab-note").click();
    await editor("Journal-A").waitFor();
    assert.equal(
      await editor("Journal-A").locator("strong").textContent(),
      "saved",
    );
    let policyRows = 0;
    for (const archived of [false, true]) {
      if (archived) {
        await f.admin.query(
          "UPDATE projects SET status='archived' WHERE id=$1",
          [f.project.id],
        );
        await f.page.reload();
        await f.page.locator("#tab-lab-note").click();
        await editor("Journal-A").waitFor();
      }
      for (const mode of ["text", "rendered"]) {
        await (mode === "text" ? text : rich).click();
        for (const busy of [false, true]) {
          let release: (() => void) | undefined;
          if (busy) {
            let resolveGate!: () => void;
            let entered!: () => void;
            const gate = new Promise<void>((resolve) => {
              resolveGate = resolve;
            });
            const requested = new Promise<void>((resolve) => {
              entered = resolve;
            });
            release = resolveGate;
            releases.push(resolveGate);
            const url = `${root}/notebooks/${saved.id}/versions/git/retry`;
            await f.page.route(`**${url}`, async (route) => {
              entered();
              await gate;
              await route.continue();
            });
            await panel
              .getByRole("button", { name: "保存履歴", exact: true })
              .click();
            await f.page
              .getByRole("dialog")
              .getByRole("button", { name: "Git 出力を再試行", exact: true })
              .click();
            await requested;
          }
          assert.equal(
            await editor("Journal-A").getAttribute("contenteditable"),
            archived || busy ? "false" : "true",
          );
          assert.equal(await timestamp.isDisabled(), archived || busy);
          if (mode === "rendered")
            for (const name of [
              "見出し1",
              "見出し2",
              "見出し3",
              "太字",
              "斜体",
              "打消し線",
            ]) {
              assert.equal(
                await panel
                  .getByRole("button", {
                    name,
                    exact: true,
                    includeHidden: true,
                  })
                  .isDisabled(),
                archived || busy,
              );
            }
          policyRows++;
          if (release) {
            release();
            const close = f.page
              .getByRole("dialog")
              .getByRole("button", { name: "閉じる", exact: true });
            await close.click();
            await f.page.unroute(
              `**${root}/notebooks/${saved.id}/versions/git/retry`,
            );
          }
        }
      }
    }
    assert.equal(policyRows, 8);
  },
);
