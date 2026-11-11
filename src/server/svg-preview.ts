import sharp from "sharp";
import sanitize from "sanitize-html";
import { ServiceError } from "./http";

let activeRasterizations = 0;
const rasterizationQueue: (() => void)[] = [];

/** @id CODE-DATA-ADMISSION @implements REQ-DATA-004 */
export async function withImageRasterization<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const canceled = () => new ServiceError(409, "IMAGE_PREVIEW_CANCELLED");
    const remove = (error: ServiceError) => {
      const index = rasterizationQueue.indexOf(start);
      if (index < 0) return;
      rasterizationQueue.splice(index, 1);
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(error);
    };
    const aborted = () => remove(canceled());
    const start = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      activeRasterizations++;
      void Promise.resolve()
        .then(() => {
          if (signal?.aborted) throw canceled();
          return work();
        })
        .then((value) => {
          if (signal?.aborted) throw canceled();
          return value;
        })
        .finally(() => {
          activeRasterizations--;
          rasterizationQueue.shift()?.();
        })
        .then(resolve, reject);
    };
    if (signal?.aborted) return reject(canceled());
    if (activeRasterizations < 2) return start();
    if (rasterizationQueue.length >= 8)
      return reject(new ServiceError(503, "IMAGE_PREVIEW_BUSY"));
    rasterizationQueue.push(start);
    timer = setTimeout(
      () => remove(new ServiceError(503, "IMAGE_PREVIEW_BUSY")),
      10000,
    );
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

const tags = [
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
];
const attributes = [
  "xmlns",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "opacity",
  "transform",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "id",
  "clip-path",
];

/** @id CODE-DATA-SVG @implements REQ-DATA-004 */
export async function svgPreview(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (bytes.byteLength > 256 * 1024)
    throw new ServiceError(413, "SVG_BYTE_BUDGET_EXCEEDED");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw new ServiceError(415, "INVALID_SVG");
    throw error;
  }
  source = source.replace(/^\s*<\?xml\s+[^?]*\?>/i, "");
  if (
    !/^\s*<svg(?:\s|>)/.test(source) ||
    /<!DOCTYPE|<!ENTITY|<\?/i.test(source)
  )
    throw new ServiceError(415, "UNSAFE_SVG");
  let nodes = 0;
  const safe = sanitize(source, {
    parser: {
      xmlMode: true,
      lowerCaseTags: false,
      lowerCaseAttributeNames: false,
    },
    allowedTags: tags,
    allowedAttributes: { "*": attributes },
    allowedSchemes: [],
    allowProtocolRelative: false,
    transformTags: {
      "*": (tagName, attribs) => {
        if (++nodes > 2000)
          throw new ServiceError(413, "SVG_NODE_BUDGET_EXCEEDED");
        if (
          !tags.includes(tagName) ||
          Object.keys(attribs).some((name) => !attributes.includes(name))
        )
          throw new ServiceError(415, "UNSAFE_SVG");
        for (const [name, value] of Object.entries(attribs)) {
          if (
            (name === "xmlns" && value !== "http://www.w3.org/2000/svg") ||
            (/url\s*\(/i.test(value) &&
              !/^url\(\s*#[A-Za-z][\w.-]*\s*\)$/.test(value)) ||
            /(?:https?:|file:|data:|javascript:|\/\/)/i.test(
              name === "xmlns" ? "" : value,
            )
          )
            throw new ServiceError(415, "UNSAFE_SVG");
        }
        return { tagName, attribs };
      },
    },
  });
  try {
    // Validate original XML only after rejecting active features: sanitization repairs malformed input.
    const metadata = await sharp(Buffer.from(source), {
      limitInputPixels: false,
    }).metadata();
    if (!metadata.width || !metadata.height)
      throw new ServiceError(422, "INVALID_SVG_DIMENSIONS");
    if (
      metadata.width > 8192 ||
      metadata.height > 8192 ||
      metadata.width * metadata.height > 32000000
    )
      throw new ServiceError(413, "SVG_PIXEL_BUDGET_EXCEEDED");
    const png = await withImageRasterization(
      () =>
        sharp(Buffer.from(safe), { limitInputPixels: 32000000 })
          .timeout({ seconds: 2 })
          .png()
          .toBuffer(),
      signal,
    );
    if (png.length > 10 * 1024 * 1024)
      throw new ServiceError(413, "SVG_OUTPUT_BUDGET_EXCEEDED");
    return png;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (error instanceof Error)
      throw new ServiceError(422, "SVG_RENDER_FAILED");
    throw error;
  }
}
