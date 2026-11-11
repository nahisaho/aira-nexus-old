import type { Sources } from "./sources";
import { assertLocalRequest, localResponse } from "./local-boundary";
import { ServiceError } from "./http";
/** @id CODE-CITE-ROUTES @implements REQ-CITE-001 */
export function sourceRoutes(sources: Sources) {
  return async (request: Request): Promise<Response> => {
    try {
      assertLocalRequest(request);
      const match =
        /^\/api\/projects\/([^/]+)\/sources\/([^/]+)\/([^/]+)$/.exec(
          new URL(request.url).pathname,
        );
      if (!match) throw new ServiceError(404, "ROUTE_NOT_FOUND");
      if (request.method !== "GET")
        return localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
      return localResponse(
        await sources.resolve("local", match[1], match[2], match[3]),
      );
    } catch (error) {
      if (error instanceof ServiceError)
        return localResponse({ code: error.code }, error.status);
      console.error("SOURCE_ROUTE_FAILED");
      return localResponse({ code: "INTERNAL_ERROR" }, 500);
    }
  };
}
