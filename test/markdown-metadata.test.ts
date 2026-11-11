import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDocument } from "yaml";
import {
  parseJournal,
  journalSource,
  journalSchema,
} from "../src/lib/journal-markdown";
import {
  markdownBody,
  markdownUpload,
  updateMarkdownMetadata,
} from "../src/lib/markdown-metadata";

function header(source: string) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  assert.ok(match);
  return parseDocument(match[1]);
}

/** @id TEST-MARKDOWN-005 @verifies REQ-MARKDOWN-004 REQ-MARKDOWN-005 */
test("TEST-MARKDOWN-005 journal projections retain source metadata and advanced content", () => {
  const fixtures = [
    "\uFEFF# First\n\n**bold** and *italic* and ~~strike~~",
    "\uFEFF---\ntitle: original\n---\n# First",
    updateMarkdownMetadata("# tracked", "Test", "2026-11-11T00:00:00.000Z"),
  ];
  for (const source of fixtures) {
    assert.doesNotThrow(() => parseJournal(source, "rendered"));
    const parsed = parseJournal(source, "rendered");
    const body = markdownBody(source);
    assert.equal(parsed.prefix, source.slice(0, source.length - body.length));
    assert.ok(
      journalSource(parsed.doc, parsed.prefix, "rendered").startsWith(
        parsed.prefix,
      ),
    );
    const text = parseJournal(source, "text");
    assert.equal(journalSource(text.doc, text.prefix, "text"), source);
  }
  for (const bom of ["", "\uFEFF"]) {
    const parsed = parseJournal(`${bom}---\ntitle: empty\n---`, "rendered");
    const edited = journalSchema.node("doc", null, [
      journalSchema.nodes.paragraph.create(null, journalSchema.text("edited")),
    ]);
    assert.equal(
      markdownBody(journalSource(edited, parsed.prefix, "rendered")),
      "edited",
    );
  }
  for (const source of [
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "```mermaid\nflowchart LR\n A-->B\n```",
    "```python\nprint('inert')\n```",
    "formula $x^2$ end",
    "formula \\(x^2\\) end",
    "$$\nx^2\n$$",
    "\\[\nx^2\n\\]",
    "![owned](aira-file:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)",
  ]) {
    const parsed = parseJournal(`new paragraph\n\n${source}`, "rendered");
    assert.ok(
      journalSource(parsed.doc, parsed.prefix, "rendered").includes(source),
      source,
    );
  }
});

/** @id TEST-MARKDOWN-006 @verifies REQ-MARKDOWN-004 REQ-MARKDOWN-005 */
test("TEST-MARKDOWN-006 journal parsing rejects invalid and over-budget rich input without dropping literal recovery", () => {
  assert.doesNotThrow(() => parseJournal("# valid", "rendered"));
  const invalid = "---\nx: [\n---\nbody";
  assert.throws(
    () => parseJournal(invalid, "rendered"),
    /INVALID_MARKDOWN_FRONTMATTER/,
  );
  assert.equal(
    journalSource(parseJournal(invalid, "text").doc, "", "text"),
    invalid,
  );
  for (const tooLarge of ["あ".repeat(21846), "x".repeat(65537)]) {
    assert.throws(
      () => parseJournal(tooLarge, "rendered"),
      /JOURNAL_SOURCE_BUDGET_EXCEEDED/,
    );
    assert.equal(
      journalSource(parseJournal(tooLarge, "text").doc, "", "text"),
      tooLarge,
    );
  }
  assert.doesNotThrow(() => parseJournal("a".repeat(65536), "rendered"));
  assert.throws(
    () => parseJournal("x\n\n" + "```\na\n```\n\n".repeat(101), "rendered"),
    /JOURNAL_PREVIEW_LIMIT/,
  );
  const hostile =
    "![remote](https://example.invalid/x.png)\n\n[bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>";
  const parsed = parseJournal(hostile, "rendered");
  assert.ok(
    journalSource(parsed.doc, parsed.prefix, "rendered").includes(
      "example.invalid",
    ),
  );
});

/** @id TEST-MARKDOWN-001 @verifies REQ-MARKDOWN-002 */
test("TEST-MARKDOWN-001 YAML preserves creation time, appends editors and protects saved history", () => {
  const original = "---\ntitle: Research notes\n---\n# First\n\n$x^2$\n";
  const first = updateMarkdownMetadata(
    original,
    "Alice",
    "2026-11-11T00:00:00.000Z",
  );
  assert.equal(header(first).get("title"), "Research notes");
  assert.equal(
    header(first).getIn(["aira", "created_at"]),
    "2026-11-11T00:00:00.000Z",
  );
  assert.equal(
    header(first).getIn(["aira", "updated_at"]),
    "2026-11-11T00:00:00.000Z",
  );
  assert.equal(
    header(first).getIn(["aira", "editor_history", 0, "editor"]),
    "Alice",
  );
  assert.equal(
    header(first).getIn(["aira", "editor_identity"]),
    "self-declared",
  );
  assert.equal(markdownBody(first), "# First\n\n$x^2$\n");
  assert.equal(
    updateMarkdownMetadata(first, "Bob", "2026-11-12T00:00:00.000Z", first),
    first,
  );
  const edited = first
    .replace("# First", "# Second")
    .replace("Alice", "Forged");
  const second = updateMarkdownMetadata(
    edited,
    "Bob",
    "2026-11-12T00:00:00.000Z",
    first,
  );
  assert.equal(
    header(second).getIn(["aira", "created_at"]),
    "2026-11-11T00:00:00.000Z",
  );
  assert.equal(
    header(second).getIn(["aira", "updated_at"]),
    "2026-11-12T00:00:00.000Z",
  );
  assert.equal(
    header(second).getIn(["aira", "editor_history", 0, "editor"]),
    "Alice",
  );
  assert.equal(
    header(second).getIn(["aira", "editor_history", 1, "editor"]),
    "Bob",
  );
  assert.equal(header(second).getIn(["aira", "editor_history", 2]), undefined);
  assert.equal(markdownBody(second), "# Second\n\n$x^2$\n");
});

/** @id TEST-MARKDOWN-002 @verifies REQ-MARKDOWN-002 */
test("TEST-MARKDOWN-002 file metadata preserves body bytes across bounded UTF-8 reads", async () => {
  const body = "x".repeat(65534) + "温度📈\n";
  const file = new File([body], "observations.md", { type: "text/markdown" });
  const uploaded = await markdownUpload(file, "Demo Editor");
  const stored = await uploaded.text();
  assert.ok(stored.endsWith(body));
  assert.equal(markdownBody(stored), body);
  assert.equal(
    header(stored).getIn(["aira", "editor_history", 0, "editor"]),
    "Demo Editor",
  );
  assert.equal(await file.text(), body);
  const revised = await markdownUpload(
    new File([stored.replace("温度", "結果")], "observations.md"),
    "Second Editor",
  );
  const final = await revised.text();
  assert.equal(
    header(final).getIn(["aira", "created_at"]),
    header(stored).getIn(["aira", "created_at"]),
  );
  assert.equal(
    header(final).getIn(["aira", "editor_history", 1, "editor"]),
    "Second Editor",
  );
  assert.ok(final.endsWith(body.replace("温度", "結果")));
  const uploadedAgain = await markdownUpload(
    new File([final], "observations.md"),
    "Third Editor",
  );
  const unchanged = await uploadedAgain.text();
  assert.equal(
    header(unchanged).getIn(["aira", "created_at"]),
    header(stored).getIn(["aira", "created_at"]),
  );
  assert.equal(
    header(unchanged).getIn(["aira", "editor_history", 2, "editor"]),
    "Third Editor",
  );
  assert.equal(markdownBody(unchanged), markdownBody(final));
});

/** @id TEST-MARKDOWN-003 @verifies REQ-MARKDOWN-002 REQ-MARKDOWN-003 */
test("TEST-MARKDOWN-003 invalid, aliased and oversized YAML fail without truncating history", () => {
  for (const source of [
    "---\ntitle: A\ntitle: B\n---\nBody",
    "---\ntitle: &title A\ncopy: *title\n---\nBody",
    "---\nvalue: !custom content\n---\nBody",
    "---\naira: {created_at: invalid}\n---\nBody",
    `---\ntitle: ${"x".repeat(65536)}\n---\nBody`,
  ])
    assert.throws(() => updateMarkdownMetadata(source, "Editor"), /MARKDOWN/);
  assert.throws(() => updateMarkdownMetadata("Body", "\n"), /EDITOR_NAME/);
  const name = "📈".repeat(80);
  assert.equal(
    header(updateMarkdownMetadata("Body", ` ${name} `)).getIn([
      "aira",
      "editor_history",
      0,
      "editor",
    ]),
    name,
  );
  assert.throws(
    () => updateMarkdownMetadata("Body", name + "x"),
    /EDITOR_NAME/,
  );
});

/** @id TEST-MARKDOWN-004 @verifies REQ-MARKDOWN-002 */
test("TEST-MARKDOWN-004 preserves leading BOM and exact body on uploads and cell saves", async (t) => {
  const body = "# 温度📈\r\n\nTrailing bytes\r\n";
  const encoder = new TextEncoder();
  for (const frontMatter of ["", "---\r\ntitle: Lab\r\n---\r\n"]) {
    const source = `\uFEFF${frontMatter}${body}`;
    for (const operation of ["upload", "cell"] as const) {
      await t.test(
        `${operation}, ${frontMatter ? "existing" : "new"} header`,
        async () => {
          const file = new File([source], "bom.md", { type: "text/markdown" });
          const updated =
            operation === "upload"
              ? new Uint8Array(
                  await (await markdownUpload(file, "Editor")).arrayBuffer(),
                )
              : encoder.encode(
                  updateMarkdownMetadata(
                    source,
                    "Editor",
                    "2026-11-11T00:00:00.000Z",
                  ),
                );
          assert.deepEqual(
            updated.slice(0, 3),
            new Uint8Array([0xef, 0xbb, 0xbf]),
          );
          const stored = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
            updated,
          );
          const match = /^\uFEFF---\n[\s\S]*?\n---\n/.exec(stored);
          assert.ok(match, "BOM must precede the managed header");
          assert.deepEqual(
            updated.slice(encoder.encode(match[0]).length),
            encoder.encode(body),
            "body bytes must not contain a moved BOM or old header fragment",
          );
          assert.equal(markdownBody(stored), body);
          assert.deepEqual(
            new Uint8Array(await file.arrayBuffer()),
            encoder.encode(source),
          );
          if (operation === "cell")
            assert.equal(
              updateMarkdownMetadata(
                stored,
                "Next Editor",
                "2026-11-12T00:00:00.000Z",
                stored,
              ),
              stored,
              "an unchanged tracked Notebook save retains exact source",
            );
        },
      );
    }
  }
  await t.test(
    "body display excludes a leading encoding BOM without a header",
    () => {
      assert.equal(markdownBody(`\uFEFF${body}`), body);
    },
  );
  await t.test("header read budget includes the BOM and delimiters", () => {
    const opening = "\uFEFF---\npad: ";
    const closing = "\n---\n";
    const padding = "x".repeat(
      64 * 1024 - encoder.encode(opening + closing).length,
    );
    assert.equal(markdownBody(opening + padding + closing + body), body);
    assert.throws(
      () => markdownBody(opening + padding + "x" + closing + body),
      /MARKDOWN_METADATA_BUDGET_EXCEEDED/,
    );
  });
});
