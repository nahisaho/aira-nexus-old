import type { Files } from "./files";
import { ServiceError } from "./http";
import sharp, { type Metadata } from "sharp";
import { svgPreview, withImageRasterization } from "./svg-preview";
export type FilePreview =
  | { kind: "text"; text: string; omittedBytes: number }
  | { kind: "image"; bytes: Uint8Array; mime: "image/png" };
/** @id CODE-DATA-IMAGE @implements REQ-DATA-004 */
export async function previewMarkdownImage(
  files: Files,
  actor: string,
  projectId: string,
  id: string,
  signal?: AbortSignal,
): Promise<Extract<FilePreview, { kind: "image" }>> {
  const file = await files.get(actor, projectId, id);
  if (file.mime === "image/svg+xml") {
    if (file.size > 256 * 1024)
      throw new ServiceError(413, "SVG_BYTE_BUDGET_EXCEEDED");
    await files.storage.verify(file.blobId, file.size, file.sha256);
    const chunks: Uint8Array[] = [];
    for await (const chunk of files.storage.read(file.blobId))
      chunks.push(chunk);
    return {
      kind: "image",
      bytes: await svgPreview(Buffer.concat(chunks), signal),
      mime: "image/png",
    };
  }
  const preview = await previewFile(files, actor, projectId, id, signal);
  if (preview.kind !== "image") throw new ServiceError(415, "NOT_AN_IMAGE");
  return preview;
}
/** @id CODE-DATA-PREVIEW @implements REQ-DATA-003 */
export async function previewFile(
  files: Files,
  actor: string,
  projectId: string,
  id: string,
  signal?: AbortSignal,
): Promise<FilePreview> {
  const file = await files.get(actor, projectId, id);
  await files.storage.verify(file.blobId, file.size, file.sha256);
  if (file.mime === "image/png" || file.mime === "image/jpeg") {
    if (file.size > 10 * 1024 * 1024)
      throw new ServiceError(413, "RASTER_BYTE_BUDGET_EXCEEDED");
    const chunks = [];
    for await (const chunk of files.storage.read(file.blobId))
      chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (
      (file.mime === "image/png" && !png) ||
      (file.mime === "image/jpeg" && !jpeg)
    )
      throw new ServiceError(415, "RASTER_SIGNATURE_MISMATCH");
    let metadata: Metadata;
    try {
      metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
    } catch {
      throw new ServiceError(422, "INVALID_RASTER");
    }
    const width = metadata.width ?? 0,
      height = metadata.height ?? 0;
    if (
      !width ||
      !height ||
      width > 8192 ||
      height > 8192 ||
      width * height > 32000000 ||
      (metadata.pages ?? 1) > 1
    )
      throw new ServiceError(413, "RASTER_PIXEL_BUDGET_EXCEEDED");
    let sanitized: Buffer;
    try {
      sanitized = await withImageRasterization(
        () =>
          sharp(bytes, {
            limitInputPixels: 32000000,
            sequentialRead: true,
          })
            .png()
            .toBuffer(),
        signal,
      );
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(422, "INVALID_RASTER");
    }
    if (sanitized.length > 10 * 1024 * 1024)
      throw new ServiceError(413, "RASTER_BYTE_BUDGET_EXCEEDED");
    return { kind: "image", bytes: sanitized, mime: "image/png" };
  }
  if (
    /\.(html?|svg|xml)$/i.test(file.name) ||
    file.mime === "text/html" ||
    file.mime === "image/svg+xml"
  )
    throw new ServiceError(415, "ATTACHMENT_ONLY");
  if (
    !file.mime.startsWith("text/") &&
    !["application/json", "application/x-ipynb+json"].includes(file.mime) &&
    !/\.(txt|csv|tsv|json|md|markdown|py|r|js|ts|ipynb)$/i.test(file.name)
  )
    throw new ServiceError(415, "ATTACHMENT_ONLY");
  const handle = await files.storage.open(file.blobId);
  let bytes: Buffer;
  try {
    const buffer = Buffer.alloc(Math.min(file.size, 64 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
      {
        stream: file.size > bytes.length,
      },
    );
  } catch (error) {
    if (error instanceof TypeError)
      throw new ServiceError(415, "ATTACHMENT_ONLY");
    throw error;
  }
  if (/^\s*<(?:!doctype\s+html|html\b|svg\b|\?xml)/i.test(text))
    throw new ServiceError(415, "ATTACHMENT_ONLY");
  return {
    kind: "text",
    text,
    omittedBytes: file.size - Buffer.byteLength(text),
  };
}
