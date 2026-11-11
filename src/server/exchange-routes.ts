import type { Exchange } from "./exchange";
import { assertLocalRequest, localResponse, MAX_REQUEST_BYTES } from "./local-boundary";
import { ServiceError } from "./http";
async function documentBody(request: Request) {
  const type = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && type !== "application/x-ipynb+json")
    throw new ServiceError(415, "NOTEBOOK_CONTENT_TYPE_REQUIRED");
  const reader = request.body?.getReader();
  if (!reader) throw new ServiceError(400, "NOTEBOOK_BODY_REQUIRED");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_REQUEST_BYTES) { await reader.cancel(); throw new ServiceError(413, "EXCHANGE_BODY_TOO_LARGE"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) !== size) throw new ServiceError(400, "CONTENT_LENGTH_MISMATCH");
  return Buffer.concat(chunks, size);
}
/** @id CODE-XCH-ROUTES @implements REQ-XCH-001 REQ-XCH-002 */
export function exchangeRoutes(exchange: Exchange) {
  return async (request: Request): Promise<Response> => {
    try {
      assertLocalRequest(request);
      const url = new URL(request.url);
      const incoming = /^\/api\/projects\/([^/]+)\/notebooks\/import$/.exec(url.pathname);
      if (incoming && request.method === "POST")
        return localResponse(await exchange.import("local", incoming[1], url.searchParams.get("name") ?? "Imported notebook", await documentBody(request)), 201);
      const outgoing = /^\/api\/projects\/([^/]+)\/notebooks\/([^/]+)\/export$/.exec(url.pathname);
      if (outgoing && request.method === "GET") {
        const bytes = await exchange.export("local", outgoing[1], outgoing[2]);
        const response = localResponse(null);
        response.headers.set("Content-Type", "application/x-ipynb+json; charset=utf-8");
        response.headers.set("Content-Disposition", `attachment; filename="notebook-${outgoing[2]}.ipynb"`);
        return new Response(new Uint8Array(bytes), { headers: response.headers });
      }
      if (incoming || outgoing) return localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
      throw new ServiceError(404, "ROUTE_NOT_FOUND");
    } catch (error) {
      if (error instanceof ServiceError) return localResponse({ code: error.code }, error.status);
      console.error("EXCHANGE_ROUTE_FAILED");
      return localResponse({ code: "INTERNAL_ERROR" }, 500);
    }
  };
}
