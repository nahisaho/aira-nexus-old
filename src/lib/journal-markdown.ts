import MarkdownIt from "markdown-it";
import { Schema, type Node } from "prosemirror-model";
import {
  schema,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "prosemirror-markdown";
import { markdownParts } from "./markdown-metadata";

export type JournalMode = "text" | "rendered";
export const journalBudget = 65536;
export const journalBytes = (source: string) =>
  new TextEncoder().encode(source).length;
export const journalSchema = new Schema({
  nodes: schema.spec.nodes
    .update("image", {
      ...schema.spec.nodes.get("image"),
      toDOM: (node) => [
        "span",
        { "data-inert-image": "true" },
        node.attrs.alt || "image",
      ],
      parseDOM: [],
    })
    .append({
      raw_block: {
        group: "block",
        atom: true,
        attrs: { source: {} },
        toDOM: (node) => [
          "pre",
          { contenteditable: "false" },
          node.attrs.source,
        ],
        parseDOM: [],
      },
    }),
  marks: schema.spec.marks
    .update("link", {
      ...schema.spec.marks.get("link"),
      toDOM: () => ["span", { "data-inert-link": "true" }, 0],
      parseDOM: [],
    })
    .append({
      strike: { toDOM: () => ["s", 0], parseDOM: [{ tag: "s" }] },
    }),
});

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});
markdown.core.ruler.after("inline", "journal_source_blocks", (state) => {
  const original: unknown = state.env.journalSource;
  if (typeof original !== "string") throw new Error("JOURNAL_SOURCE_REQUIRED");
  const lines = original.split("\n");
  const result = [];
  let previews = 0;
  for (let i = 0; i < state.tokens.length; i++) {
    const first = state.tokens[i];
    let end = i;
    if (first.nesting === 1) {
      let depth = 1;
      while (depth && end + 1 < state.tokens.length)
        depth += state.tokens[++end].nesting;
    }
    const block = state.tokens.slice(i, end + 1);
    if (
      block.some(
        (token) =>
          ["table_open", "fence", "code_block"].includes(token.type) ||
          (token.type === "inline" &&
            (/\$|\\\(|\\\[/.test(token.content) ||
              token.children?.some((child) => {
                const src = child.attrGet("src");
                return (
                  child.type === "image" &&
                  typeof src === "string" &&
                  src.startsWith("aira-file:")
                );
              }))),
      )
    ) {
      if (!first.map) throw new Error("JOURNAL_UNMAPPED_PREVIEW");
      if (++previews > 100) throw new Error("JOURNAL_PREVIEW_LIMIT");
      const token = new state.Token("raw_block", "", 0);
      token.content = lines.slice(first.map[0], first.map[1]).join("\n");
      result.push(token);
    } else result.push(...block);
    i = end;
  }
  state.tokens = result;
});
const parser = new MarkdownParser(journalSchema, markdown, {
  ...defaultMarkdownParser.tokens,
  s: { mark: "strike" },
  raw_block: {
    node: "raw_block",
    getAttrs: (token) => ({ source: token.content }),
  },
});
const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    raw_block(state, node) {
      state.write(node.attrs.source);
      state.closeBlock(node);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    strike: {
      open: "~~",
      close: "~~",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
  },
);

/** @id CODE-JOURNAL-MARKDOWN @implements REQ-MARKDOWN-004 REQ-MARKDOWN-005 */
export function parseJournal(
  source: string,
  mode: JournalMode,
): { doc: Node; prefix: string } {
  if (mode === "text")
    return {
      doc: journalSchema.node("doc", null, [
        journalSchema.node(
          "code_block",
          null,
          source ? journalSchema.text(source) : undefined,
        ),
      ]),
      prefix: "",
    };
  if (journalBytes(source) > journalBudget)
    throw new Error("JOURNAL_SOURCE_BUDGET_EXCEEDED");
  const { prefix, body } = markdownParts(source);
  return { doc: parser.parse(body, { journalSource: body }), prefix };
}

/** @id CODE-JOURNAL-SOURCE @implements REQ-MARKDOWN-004 REQ-MARKDOWN-005 */
export function journalSource(
  doc: Node,
  prefix: string,
  mode: JournalMode,
): string {
  if (mode === "text") return doc.textContent;
  const body = serializer.serialize(doc);
  const separator = prefix.endsWith("---") && body ? "\n" : "";
  return prefix + separator + body;
}
