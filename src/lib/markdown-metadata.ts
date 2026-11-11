import { Document, isMap, parseDocument } from "yaml";
import { z } from "zod";

const maximumHeaderBytes = 64 * 1024;
const encoder = new TextEncoder();
const editorSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const metadataSchema = z
  .object({
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
    editor_identity: z.literal("self-declared"),
    editor_history: z
      .array(
        z
          .object({
            edited_at: z.iso.datetime(),
            editor: editorSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .passthrough();

export function isMarkdownFile(name: string) {
  return /\.(md|markdown)$/i.test(name);
}

/** @id CODE-MARKDOWN-NAME @implements REQ-MARKDOWN-003 */
export function validEditorName(value: string) {
  return editorSchema.safeParse(value).success;
}

function frontMatter(source: string) {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    source,
  );
  if (match && encoder.encode(match[0]).length > maximumHeaderBytes)
    throw new Error("MARKDOWN_METADATA_BUDGET_EXCEEDED");
  const document = match
    ? parseDocument(match[1], { strict: true, uniqueKeys: true })
    : new Document();
  if (
    document.errors.length ||
    document.warnings.length ||
    (document.contents !== null && !isMap(document.contents))
  )
    throw new Error("INVALID_MARKDOWN_FRONTMATTER");
  let root: unknown;
  try {
    root = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof ReferenceError)
      throw new Error("INVALID_MARKDOWN_FRONTMATTER");
    throw error;
  }
  const candidate =
    root && typeof root === "object" && !Array.isArray(root) && "aira" in root
      ? root.aira
      : undefined;
  let metadata: z.infer<typeof metadataSchema> | undefined;
  if (candidate !== undefined) {
    const parsed = metadataSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("INVALID_MARKDOWN_METADATA");
    metadata = parsed.data;
  }
  return {
    document,
    metadata,
    bom,
    header: match?.[0] ?? "",
    body: source.slice(match ? match[0].length : bom.length),
  };
}

export function markdownBody(source: string) {
  return frontMatter(source).body;
}

export function markdownParts(source: string) {
  const parsed = frontMatter(source);
  return { prefix: parsed.header || parsed.bom, body: parsed.body };
}

/** @id CODE-MARKDOWN-METADATA @implements REQ-MARKDOWN-002 */
export function updateMarkdownMetadata(
  source: string,
  editor: string,
  now = new Date().toISOString(),
  previous?: string,
) {
  const name = editorSchema.safeParse(editor);
  if (!name.success) throw new Error("INVALID_EDITOR_NAME");
  if (!z.iso.datetime().safeParse(now).success)
    throw new Error("INVALID_MARKDOWN_TIMESTAMP");
  const current = frontMatter(source);
  const stored = previous === undefined ? undefined : frontMatter(previous);
  if (source === previous && stored?.metadata) return source;
  const metadata = stored?.metadata ?? current.metadata;
  current.document.set("aira", {
    ...metadata,
    created_at: metadata?.created_at ?? now,
    updated_at: now,
    editor_identity: "self-declared",
    editor_history: [
      ...(metadata?.editor_history ?? []),
      { edited_at: now, editor: name.data },
    ],
  });
  const header = `${current.bom}---\n${current.document.toString()}---\n`;
  if (encoder.encode(header).length > maximumHeaderBytes)
    throw new Error("MARKDOWN_METADATA_BUDGET_EXCEEDED");
  return header + current.body;
}

export async function markdownUpload(
  file: File,
  editor: string,
): Promise<Blob> {
  const bytes = await file.slice(0, maximumHeaderBytes + 4).arrayBuffer();
  let prefix: string;
  try {
    prefix = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
      {
        stream: file.size > bytes.byteLength,
      },
    );
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error("INVALID_MARKDOWN_ENCODING");
    throw error;
  }
  const original = frontMatter(prefix);
  if (
    file.size > bytes.byteLength &&
    /^(?:\uFEFF)?---\r?\n/.test(prefix) &&
    !original.header
  )
    throw new Error("MARKDOWN_METADATA_BUDGET_EXCEEDED");
  const updated = frontMatter(updateMarkdownMetadata(prefix, editor));
  return new Blob(
    [
      updated.header,
      file.slice(encoder.encode(original.header || original.bom).length),
    ],
    { type: file.type || "text/markdown" },
  );
}
