import type { ResearchChecks } from "./research-checks";
import { assertLocalRequest, localResponse, readJson } from "./local-boundary";
import { ServiceError } from "./http";
/** @id CODE-CHECK-ROUTES @implements REQ-CHECK-004 */
export function checkRoutes(checks: ResearchChecks) {
  return async (request: Request): Promise<Response> => {
    try {
      assertLocalRequest(request);
      const match = /^\/api\/projects\/([^/]+)\/checks(?:\/([^/]+))?$/.exec(
        new URL(request.url).pathname,
      );
      if (!match) throw new ServiceError(404, "ROUTE_NOT_FOUND");
      if (request.method === "GET" && match[2] && match[2] !== "preview")
        return localResponse(await checks.get("local", match[1], match[2]));
      if (request.method !== "POST")
        return localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
      if (match[2] === "preview")
        return localResponse(
          await checks.preview("local", match[1], await readJson(request)),
        );
      if (match[2]) throw new ServiceError(404, "ROUTE_NOT_FOUND");
      return localResponse(
        await checks.run("local", match[1], await readJson(request)),
      );
    } catch (error) {
      if (error instanceof ServiceError)
        return localResponse({ code: error.code }, error.status);
      console.error("CHECK_ROUTE_FAILED");
      return localResponse({ code: "INTERNAL_ERROR" }, 500);
    }
  };
}
