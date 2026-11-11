import { parentPort, workerData } from "node:worker_threads";
import MarkdownIt, { type Token } from "markdown-it";
import katex from "katex";
import sanitize from "sanitize-html";
import type { RenderingError } from "./scientific-rendering";
import { markdownBody } from "../lib/markdown-metadata.ts";
const mathTags = [
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mn",
  "mo",
  "mtext",
  "mspace",
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "munder",
  "mover",
  "munderover",
  "mtable",
  "mtr",
  "mtd",
  "mstyle",
  "mpadded",
  "mphantom",
  "menclose",
  "mmultiscripts",
  "mprescripts",
  "none",
];
const mathAttributes = [
  "mathvariant",
  "displaystyle",
  "scriptlevel",
  "stretchy",
  "fence",
  "separator",
  "lspace",
  "rspace",
  "width",
  "height",
  "depth",
  "columnalign",
  "rowalign",
  "columnspacing",
  "rowspacing",
  "accent",
  "accentunder",
  "notation",
  "voffset",
];
const delimiters = [
  ["$$", "$$"],
  ["\\[", "\\]"],
  ["\\(", "\\)"],
  ["$", "$"],
];
function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function closing(source: string, value: string, from: number) {
  for (
    let index = source.indexOf(value, from);
    index !== -1;
    index = source.indexOf(value, index + value.length)
  ) {
    let slashes = 0;
    for (
      let cursor = index - 1;
      cursor >= 0 && source[cursor] === "\\";
      cursor--
    )
      slashes++;
    if (slashes % 2 === 0) return index;
  }
  return -1;
}
/** @id CODE-RENDER-WORKER @implements REQ-RENDER-001 REQ-RENDER-002 REQ-RENDER-003 */
function render(input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    !("source" in input) ||
    typeof input.source !== "string" ||
    Buffer.byteLength(input.source) > 65536
  )
    throw new Error("INVALID_RENDER_WORKER_INPUT");
  const source = markdownBody(input.source);
  const projectId =
    "projectId" in input && typeof input.projectId === "string"
      ? input.projectId
      : undefined;
  const errors: RenderingError[] = [];
  let formulas = 0,
    outputBytes = 0;
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
  });
  function errorMath(token: Token, kind: string, message: string) {
    errors.push({ kind, message });
    return `<span class="math-error"><code>${escape(token.markup)}</code><span> Rendering error: ${escape(message)}</span></span>`;
  }
  function renderMath(token: Token) {
    if (++formulas > 100)
      return errorMath(token, "formula_count", "More than 100 formulas");
    if (Buffer.byteLength(token.content) > 8192)
      return errorMath(token, "formula_limit", "Formula exceeds 8 KiB");
    if (
      /\\(?:href|url|includegraphics|htmlClass|htmlId|htmlStyle|htmlData)\b/.test(
        token.content,
      )
    )
      return errorMath(
        token,
        "untrusted_macro",
        "HTML, link and media math macros are not allowed",
      );
    let rendered: string;
    try {
      rendered = katex.renderToString(token.content, {
        output: "mathml",
        displayMode: token.block,
        trust: false,
        throwOnError: true,
        strict: "error",
        maxExpand: 1000,
      });
    } catch (error) {
      if (!(error instanceof katex.ParseError)) throw error;
      return errorMath(token, "invalid_math", error.message);
    }
    const safe = sanitize(rendered, {
      allowedTags: mathTags,
      allowedAttributes: {
        "*": mathAttributes,
        math: ["xmlns", "display"],
        annotation: ["encoding"],
      },
      allowedSchemes: [],
      allowProtocolRelative: false,
    });
    outputBytes += Buffer.byteLength(safe);
    return outputBytes > 1024 ** 2
      ? errorMath(token, "output_limit", "Rendered output exceeds 1 MiB")
      : safe;
  }
  md.inline.ruler.before("escape", "science_math", (state, silent) => {
    const pair = delimiters.find(([open]) =>
      state.src.startsWith(open, state.pos),
    );
    if (!pair) return false;
    const [open, close] = pair;
    const end = closing(state.src, close, state.pos + open.length);
    const stop = end < 0 ? state.posMax : end + close.length;
    if (!silent) {
      const token = state.push("science_math", "", 0);
      token.content = state.src.slice(
        state.pos + open.length,
        end < 0 ? stop : end,
      );
      token.markup = state.src.slice(state.pos, stop);
      token.block = open === "$$" || open === "\\[";
      token.meta = { unclosed: end < 0 };
    }
    state.pos = stop;
    return true;
  });
  md.block.ruler.before(
    "fence",
    "science_math_block",
    (state, start, end, silent) => {
      const begin = state.bMarks[start] + state.tShift[start];
      const pair = delimiters
        .slice(0, 2)
        .find(([open]) => state.src.startsWith(open, begin));
      if (!pair) return false;
      const [open, close] = pair,
        finish = closing(state.src, close, begin + open.length);
      if (finish < 0 || finish >= state.eMarks[end - 1]) return false;
      let last = start;
      while (last < end && state.eMarks[last] < finish + close.length) last++;
      if (
        last >= end ||
        state.src.slice(finish + close.length, state.eMarks[last]).trim()
      )
        return false;
      if (silent) return true;
      const token = state.push("science_math", "", 0);
      token.content = state.src.slice(begin + open.length, finish);
      token.markup = state.src.slice(begin, finish + close.length);
      token.block = true;
      token.map = [start, last + 1];
      state.line = last + 1;
      return true;
    },
  );
  md.renderer.rules.science_math = (tokens, index) =>
    tokens[index].meta?.unclosed
      ? errorMath(tokens[index], "invalid_math", "Unclosed math delimiter")
      : renderMath(tokens[index]);
  md.renderer.rules.image = (tokens, index) => {
    const token = tokens[index];
    const attribute = token.attrGet("src");
    const match =
      /^aira-file:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
        typeof attribute === "string" ? attribute : "",
      );
    return projectId && match
      ? `<img src="/api/projects/${projectId}/files/${match[1].toLowerCase()}/image" alt="${escape(token.content)}" loading="lazy" decoding="async">`
      : escape(`[Image omitted: ${token.content}]`);
  };
  const links: boolean[] = [];
  md.renderer.rules.link_open = (tokens, index) => {
    const attribute = tokens[index].attrGet("href");
    const href = typeof attribute === "string" ? attribute : "";
    let safe = /^https?:\/\//i.test(href);
    if (safe) {
      try {
        safe = ["http:", "https:"].includes(new URL(href).protocol);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        safe = false;
      }
    }
    links.push(safe);
    return safe
      ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">`
      : '<span class="blocked-link">';
  };
  md.renderer.rules.link_close = () => (links.pop() ? "</a>" : "</span>");
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  md.renderer.rules.text = (tokens, index) => {
    const text = tokens[index].content;
    if (links.length) return escape(text);
    let result = "",
      cursor = 0;
    for (const match of text.matchAll(/\[(run|file|cell):([^\]]+)\]/g)) {
      result += escape(text.slice(cursor, match.index));
      result +=
        projectId && match[1] !== "cell" && uuid.test(match[2])
          ? `<a data-citation="${match[1]}" href="/api/projects/${projectId}/sources/${match[1]}/${match[2].toLowerCase()}">${escape(match[0])}</a>`
          : `<span class="unresolved-reference">${escape(match[0])} (unresolved reference)</span>`;
      cursor = match.index + match[0].length;
    }
    return result + escape(text.slice(cursor));
  };
  let html = sanitize(md.render(source, {}), {
    allowedTags: [
      ...mathTags,
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "pre",
      "code",
      "strong",
      "em",
      "del",
      "blockquote",
      "hr",
      "br",
      "a",
      "span",
      "img",
    ],
    allowedAttributes: {
      "*": mathAttributes,
      math: ["xmlns", "display"],
      annotation: ["encoding"],
      a: ["href", "target", "rel", "data-citation"],
      span: ["class"],
      code: ["class"],
      p: ["class", "role"],
      img: ["src", "alt", "loading", "decoding"],
    },
    allowedSchemes: ["http", "https"],
    allowProtocolRelative: false,
  });
  if (Buffer.byteLength(html) > 1024 ** 2) {
    errors.push({
      kind: "output_limit",
      message: "Rendered output exceeds 1 MiB",
    });
    html = `<p role="alert">Rendering error: rendered output exceeds 1 MiB</p><pre>${escape(source)}</pre>`;
  }
  return { html, errors };
}
if (!parentPort) throw new Error("RENDER_WORKER_ENTRY_REQUIRED");
parentPort.postMessage(Buffer.from(JSON.stringify(render(workerData))));
parentPort.close();
