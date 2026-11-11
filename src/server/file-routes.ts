import type { Files } from "./files";
import { localResponse, assertLocalRequest } from "./local-boundary";
import { ServiceError } from "./http";
import { MAX_FILE_BYTES } from "./files";
import { previewFile, previewMarkdownImage } from "./file-preview";

async function* bodyChunks(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let ended = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        ended = true;
        break;
      }
      yield next.value;
    }
  } finally {
    if (!ended) await reader.cancel();
    reader.releaseLock();
  }
}
function stream(source: AsyncIterable<Uint8Array>) {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
/** @id CODE-DATA-ROUTES @implements REQ-DATA-001 REQ-DATA-002 REQ-DATA-003 */
export function fileRoutes(files: Files) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const match =
        /^\/api\/projects\/([^/]+)\/files(?:\/([^/]+)\/(download|preview|image))?$/.exec(
          url.pathname,
        );
      const upload = request.method === "POST" && match && !match[2];
      assertLocalRequest(request, upload ? MAX_FILE_BYTES : undefined);
      if (!match) throw new ServiceError(404, "ROUTE_NOT_FOUND");
      const projectId = match[1],
        id = match[2],
        action = match[3];
      if (!id && request.method === "POST") {
        if (!request.body) throw new ServiceError(400, "FILE_BODY_REQUIRED");
        return localResponse(
          await files.upload(
            "local",
            projectId,
            url.searchParams.get("name") ?? "",
            request.headers
              .get("Content-Type")
              ?.split(";")[0]
              .trim()
              .toLowerCase() ?? "application/octet-stream",
            bodyChunks(request.body),
          ),
          201,
        );
      }
      if (!id && request.method === "GET")
        return localResponse({
          versions: await files.list("local", projectId),
        });
      if (id && request.method === "GET") {
        if (action === "preview" || action === "image") {
          const preview =
            action === "image"
              ? await previewMarkdownImage(
                  files,
                  "local",
                  projectId,
                  id,
                  request.signal,
                )
              : await previewFile(
                  files,
                  "local",
                  projectId,
                  id,
                  request.signal,
                );
          if (preview.kind === "text") return localResponse(preview);
          const response = localResponse(null);
          response.headers.set("Content-Type", preview.mime);
          return new Response(Uint8Array.from(preview.bytes), {
            headers: response.headers,
          });
        }
        const file = await files.get("local", projectId, id);
        await files.storage.verify(file.blobId, file.size, file.sha256);
        const headers = localResponse(null).headers;
        headers.set("Content-Type", "application/octet-stream");
        headers.set(
          "Content-Disposition",
          `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))}`,
        );
        headers.set("Content-Length", String(file.size));
        return new Response(stream(files.storage.read(file.blobId)), {
          headers,
        });
      }
      return localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
    } catch (error) {
      if (error instanceof ServiceError)
        return localResponse({ code: error.code }, error.status);
      console.error("FILE_ROUTE_FAILED");
      return localResponse({ code: "INTERNAL_ERROR" }, 500);
    }
  };
}
