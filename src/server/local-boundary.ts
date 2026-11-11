import { ServiceError } from "./http";
import { publicOrigin } from "./trusted-lan";

export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
function declaredLength(request: Request, maximum = MAX_REQUEST_BYTES) {
  const text = request.headers.get("Content-Length");
  if (text === null) return;
  if (!/^[0-9]+$/.test(text))
    throw new ServiceError(400, "INVALID_CONTENT_LENGTH");
  const size = Number(text);
  if (!Number.isSafeInteger(size) || size > maximum)
    throw new ServiceError(413, "REQUEST_TOO_LARGE");
  return size;
}
/** @id CODE-PROJECT-BOUNDARY @implements REQ-PROJECT-004 */
export function assertLocalRequest(
  request: Request,
  bodyLimit = MAX_REQUEST_BYTES,
) {
  const host = request.headers.get("Host");
  const configured = publicOrigin();
  const publicMatch = configured?.host === host ? configured : undefined;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(
    host ?? "",
  );
  if (
    !publicMatch &&
    (!match || (match[2] !== undefined && Number(match[2]) > 65535))
  )
    throw new ServiceError(403, "LOCAL_HOST_REQUIRED");
  const protocol = new URL(request.url).protocol;
  if (protocol !== "http:" && protocol !== "https:")
    throw new ServiceError(403, "LOCAL_HOST_REQUIRED");
  const origin = request.headers.get("Origin");
  if (origin !== null) {
    let supplied: URL;
    try {
      supplied = new URL(origin);
    } catch (error) {
      if (error instanceof TypeError)
        throw new ServiceError(403, "SAME_ORIGIN_REQUIRED");
      throw error;
    }
    if (
      !/^https?:\/\/[^/?#\\]+$/i.test(origin) ||
      supplied.username ||
      supplied.password ||
      supplied.origin !==
        (publicMatch?.origin ?? new URL(`${protocol}//${host}`).origin)
    )
      throw new ServiceError(403, "SAME_ORIGIN_REQUIRED");
  }
  declaredLength(request, bodyLimit);
}
export async function readJson(request: Request): Promise<unknown> {
  const expected = declaredLength(request);
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new ServiceError(415, "JSON_CONTENT_TYPE_REQUIRED");
  const reader = request.body?.getReader();
  if (!reader) throw new ServiceError(400, "JSON_BODY_REQUIRED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ServiceError(413, "REQUEST_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (expected !== undefined && expected !== size)
    throw new ServiceError(400, "CONTENT_LENGTH_MISMATCH");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, size),
    );
  } catch (error) {
    if (error instanceof TypeError)
      throw new ServiceError(400, "INVALID_JSON_ENCODING");
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ServiceError(400, "INVALID_JSON");
    throw error;
  }
}
export function localResponse(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
    },
  });
}
