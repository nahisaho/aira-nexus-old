import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  renderScientific,
  type ScientificView,
  type MathWorkerFactory,
} from "../src/server/scientific-rendering";
import { ScientificText } from "../src/components/scientific-text";
import { ServiceError } from "../src/server/http";
import { browserFixture } from "./helpers/browser";
import { updateMarkdownMetadata } from "../src/lib/markdown-metadata";
const basic =
  "# Science\n\n- bounded\n- local\n\n| Metric | Value |\n| --- | --- |\n| AUROC | 0.83 |\n\n$x^2$ and \\(\\alpha\\).\n\n$$\\frac{1}{2}$$\n\n\\[\\sqrt{4}\\]\n\n`$code$` and `\\(code\\)`\n\n```mermaid\ngraph TD; A-->B;\n```\n\n<script>window.__unsafe = 1</script>\n";
async function rendered(
  source: string,
  options?: { projectId?: string; createWorker?: MathWorkerFactory },
) {
  let view: ScientificView | undefined;
  await assert.doesNotReject(async () => {
    view = await renderScientific(source, options);
  });
  assert.ok(view);
  return view;
}
function html(view: ScientificView) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${renderToStaticMarkup(createElement(ScientificText, { view }))}</body></html>`;
}
/** @id TEST-RENDER-005 @verifies REQ-MARKDOWN-002 */
test("TEST-RENDER-005 YAML metadata stays in source but outside rendered Markdown", async () => {
  const tracked = updateMarkdownMetadata("# Notes\n\n$x^2$", "Demo Editor");
  for (const prefix of ["", "\uFEFF"]) {
    const source = prefix + tracked;
    const view = await rendered(source);
    assert.equal(view.raw, source);
    assert.deepEqual(view.errors, []);
    assert.match(view.html, /<h1>Notes<\/h1>/);
    assert.match(view.html, /<math/);
    assert.doesNotMatch(view.html, /created_at|editor_history|Demo Editor/);
  }
});
/** @id TEST-RENDER-001 @verifies REQ-RENDER-001 */
test(
  "TEST-RENDER-001 actual scientific component switches raw/table/code/literal HTML and scalar-safe64KiB previews",
  { timeout: 120000 },
  async (t) => {
    const view = await rendered(basic);
    assert.equal(view.raw, basic);
    assert.equal(view.omittedBytes, 0);
    assert.deepEqual(view.errors, []);
    const fixture = await browserFixture(
      async () =>
        new Response(html(view), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    );
    t.after(() => fixture.close());
    const page = await fixture.browser.newPage();
    await page.goto(fixture.origin);
    assert.equal(
      await page.locator('[data-display="raw"] pre').textContent(),
      basic,
    );
    assert.equal(
      await page.locator('[data-display="scientific"] div').isVisible(),
      false,
    );
    await page.locator('[data-display="scientific"] summary').click();
    assert.equal(
      await page.locator('[data-display="raw"] pre').isVisible(),
      false,
    );
    assert.equal(await page.locator("h1").textContent(), "Science");
    assert.equal(await page.locator("table").count(), 1);
    assert.equal(await page.locator("ul li").count(), 2);
    assert.equal(await page.locator("code").count(), 3);
    assert.ok(
      (
        await page.locator('[data-display="scientific"]').textContent()
      )?.includes("<script>window.__unsafe = 1</script>"),
    );
    assert.equal(
      await page.evaluate(() => Reflect.get(window, "__unsafe")),
      undefined,
    );
    await page.locator('[data-display="raw"] summary').click();
    assert.equal(
      await page.locator('[data-display="raw"] pre').textContent(),
      basic,
    );
    const exact = await rendered("x".repeat(65536));
    assert.equal(exact.omittedBytes, 0);
    const plus = await rendered("x".repeat(65537));
    assert.equal(plus.omittedBytes, 1);
    assert.equal(plus.raw.length, 65537);
    const unicode = await rendered("x".repeat(65535) + "😀");
    assert.equal(unicode.omittedBytes, 4);
    assert.equal(unicode.raw, "x".repeat(65535) + "😀");
    assert.ok(!unicode.html.includes("\uFFFD"));
    assert.match(html(unicode), /4/);
    const bom = await rendered("\uFEFFx");
    assert.equal(bom.omittedBytes, 0);
  },
);
/** @id TEST-RENDER-004 @verifies REQ-RENDER-004 */
test("TEST-RENDER-004 Markdown embeds only canonical project-owned image routes", async () => {
  const projectId = randomUUID(),
    fileId = randomUUID();
  const source = `![Demo image](aira-file:${fileId})\n\n![Remote](https://blocked.invalid/image.png)\n\n![Data](data:image/png;base64,AAAA)\n\n![Invalid](aira-file:not-a-uuid)\n\n\`\`\`mermaid\nflowchart LR\n A --> B\n\`\`\``;
  const view = await rendered(source, { projectId });
  assert.match(
    view.html,
    new RegExp(`/api/projects/${projectId}/files/${fileId}/image`),
  );
  assert.equal((view.html.match(/<img /g) ?? []).length, 1);
  assert.match(view.html, /loading="lazy"/);
  assert.match(view.html, /language-mermaid/);
  assert.doesNotMatch(view.html, /src="(?:https?:|data:|file:)/);
  assert.doesNotMatch((await rendered(source)).html, /<img /);
});

/** @id TEST-RENDER-002 @verifies REQ-RENDER-002 */
test(
  "TEST-RENDER-002 actual MathML delimiters and formula/count/expansion/worker-message/termination limits",
  { timeout: 120000 },
  async () => {
    const view = await rendered(basic);
    assert.equal((view.html.match(/<math(?:\s|>)/g) ?? []).length, 4);
    assert.match(view.html, /<code>\$code\$<\/code>/);
    assert.deepEqual(
      (await rendered("$" + " ".repeat(8191) + "x$")).errors,
      [],
    );
    assert.ok(
      (await rendered("$" + " ".repeat(8192) + "x$")).errors.some(
        (error) => error.kind === "formula_limit",
      ),
    );
    assert.deepEqual(
      (await rendered(Array.from({ length: 100 }, () => "$x$").join(" ")))
        .errors,
      [],
    );
    assert.ok(
      (
        await rendered(Array.from({ length: 101 }, () => "$x$").join(" "))
      ).errors.some((error) => error.kind === "formula_count"),
    );
    const untrusted = await rendered(
      "$\\href{https://foreign.invalid/}{x}$ $\\htmlClass{unsafe}{x}$ $\\includegraphics{x}$",
    );
    assert.equal(
      untrusted.errors.filter((error) => error.kind === "untrusted_macro")
        .length,
      3,
    );
    for (const source of ["$\\frac{$", "$unclosed", "$\\def\\a{\\a}\\a$"]) {
      const invalid = await rendered(source);
      assert.ok(invalid.errors.some((error) => error.kind === "invalid_math"));
      assert.match(invalid.html, /Rendering error/);
    }
    const workers: Worker[] = [];
    function factory(script: string, payload?: string): MathWorkerFactory {
      return (data, options: WorkerOptions) => {
        assert.deepEqual(options.execArgv, []);
        assert.deepEqual(options.resourceLimits, {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        });
        const worker = new Worker(script, {
          ...options,
          eval: true,
          workerData: { ...data, payload },
        });
        workers.push(worker);
        return worker;
      };
    }
    const send =
      'const {parentPort,workerData}=require("node:worker_threads");parentPort.postMessage(Buffer.from(workerData.payload));parentPort.close();';
    const payload = (bytes: number) =>
      JSON.stringify({
        html: "x".repeat(
          bytes - Buffer.byteLength(JSON.stringify({ html: "", errors: [] })),
        ),
        errors: [],
      });
    const accepted = await rendered("$x$", {
      createWorker: factory(send, payload(1024 ** 2)),
    });
    assert.deepEqual(accepted.errors, []);
    assert.equal(
      Buffer.byteLength(
        JSON.stringify({ html: accepted.html, errors: accepted.errors }),
      ),
      1024 ** 2,
    );
    const refused = await rendered("$x$", {
      createWorker: factory(send, payload(1024 ** 2 + 1)),
    });
    assert.ok(refused.errors.some((error) => error.kind === "output_limit"));
    assert.match(refused.html, /\$x\$/);
    const oversizedBacking = await rendered("$x$", {
      createWorker: factory(
        'const {parentPort}=require("node:worker_threads");const message=Buffer.from(JSON.stringify({html:"",errors:[]}));const bytes=new Uint8Array(1048577);bytes.set(message);parentPort.postMessage(bytes.subarray(0,message.length));parentPort.close();',
      ),
    });
    assert.ok(
      oversizedBacking.errors.some((error) => error.kind === "output_limit"),
    );
    const timeoutStarted = performance.now();
    const timed = await rendered("$x$", {
      createWorker: factory(
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);",
      ),
    });
    assert.ok(
      performance.now() - timeoutStarted < 3500,
      "One-second worker deadline was not enforced",
    );
    assert.ok(timed.errors.some((error) => error.kind === "timeout"));
    assert.match(timed.html, /Rendering error/);
    for (const worker of workers) assert.equal(worker.threadId, -1);
    assert.deepEqual((await rendered("$x+1$")).errors, []);
    for (const mode of ["reject", "still-live", "parser-error"] as const) {
      const cleanupError = new Error("CONTROLLED_TERMINATION_FAILURE");
      const parserError = new Error("CONTROLLED_UNEXPECTED_PARSER_FAILURE");
      const marker = "CONTROLLED_PARSER_MARKER";
      const parse = JSON.parse;
      let worker: Worker | undefined;
      let terminate: (() => Promise<number>) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = renderScientific("$x$", {
          createWorker: (_data, options) => {
            worker = new Worker(
              'const {parentPort,workerData}=require("node:worker_threads");parentPort.postMessage(Buffer.from(workerData));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);',
              {
                ...options,
                eval: true,
                workerData:
                  mode === "parser-error"
                    ? marker
                    : JSON.stringify({ html: "<p>ready</p>", errors: [] }),
              },
            );
            terminate = worker.terminate.bind(worker);
            if (mode === "reject")
              worker.terminate = async () => {
                throw cleanupError;
              };
            else if (mode === "still-live") worker.terminate = async () => 0;
            else
              JSON.parse = (text, reviver) => {
                if (text === marker) throw parserError;
                return parse(text, reviver);
              };
            return worker;
          },
        });
        await assert.rejects(
          Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("RENDERING_SETTLEMENT_DEADLINE")),
                3000,
              );
            }),
          ]),
          (error: unknown) =>
            mode === "reject"
              ? error === cleanupError
              : mode === "parser-error"
                ? error === parserError
                : error instanceof ServiceError &&
                  error.status === 503 &&
                  error.code === "RENDERER_CLEANUP_UNCERTAIN",
          `${mode}: renderer must surface the original failure, not hang`,
        );
        assert.ok(worker);
        if (mode === "parser-error")
          assert.equal(
            worker.threadId,
            -1,
            "unexpected parser failures must also await worker termination",
          );
      } finally {
        JSON.parse = parse;
        clearTimeout(timer);
        if (terminate) await terminate();
        if (worker) assert.equal(worker.threadId, -1);
      }
    }
  },
);
/** @id TEST-RENDER-003 @verifies REQ-RENDER-003 */
test(
  "TEST-RENDER-003 real component makes zero automatic foreign/media/tool/reference requests and only safe clicked navigation",
  { timeout: 120000 },
  async (t) => {
    const projectId = randomUUID(),
      runId = randomUUID();
    const source = `<img src="https://blocked.invalid/raw" onerror="window.__unsafe=2">
<svg onload="window.__unsafe=3"></svg><iframe src="https://blocked.invalid/frame"></iframe>

![image](https://blocked.invalid/image.png)

[bad](javascript:alert(1)) [data](data:text/html,abc) [file](file:///etc/passwd) [relative](//blocked.invalid/other) [remote](https://external.invalid/reference)

$\\href{https://blocked.invalid/math}{x}$ $\\htmlClass{unsafe}{x}$

[run:${runId}] [cell:mutable]

\`\`\`mermaid
graph TD; A-->B;
\`\`\``;
    const view = await rendered(source, { projectId });
    const resolutions: string[] = [];
    const fixture = await browserFixture(async (request) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/")) {
        resolutions.push(path);
        return Response.json({ id: runId, synthetic: true });
      }
      return new Response(html(view), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });
    t.after(() => fixture.close());
    const context = await fixture.browser.newContext();
    const foreign: string[] = [];
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin === fixture.origin)
        await route.continue();
      else {
        foreign.push(route.request().url());
        await route.fulfill({
          status: 200,
          contentType: "text/plain",
          body: "Synthetic intercepted click; no external traffic",
        });
      }
    });
    const page = await context.newPage();
    await page.goto(fixture.origin);
    await page.locator('[data-display="scientific"] summary').click();
    assert.deepEqual(foreign, []);
    assert.deepEqual(resolutions, []);
    assert.equal(
      await page.locator("img,svg,iframe,script,object,embed").count(),
      0,
    );
    assert.equal(
      await page.evaluate(() => Reflect.get(window, "__unsafe")),
      undefined,
    );
    assert.equal(
      await page
        .locator(
          'a[href^="javascript:"],a[href^="data:"],a[href^="file:"],math [href],math [style],[onload],[onerror]',
        )
        .count(),
      0,
    );
    assert.equal(await page.locator("a").count(), 2);
    const external = page.getByRole("link", { name: "remote", exact: true });
    assert.equal(await external.getAttribute("rel"), "noopener noreferrer");
    assert.equal(await external.getAttribute("target"), "_blank");
    assert.equal(await external.getAttribute("data-prefetch"), null);
    const popupReady = context.waitForEvent("page");
    await external.click();
    const popup = await popupReady;
    await popup.waitForLoadState("load");
    assert.deepEqual(foreign, ["https://external.invalid/reference"]);
    await popup.close();
    await page.locator(`a[data-citation="run"]`).click();
    await page.waitForURL(`**/api/projects/${projectId}/sources/run/${runId}`);
    assert.deepEqual(resolutions, [
      `/api/projects/${projectId}/sources/run/${runId}`,
    ]);
  },
);
