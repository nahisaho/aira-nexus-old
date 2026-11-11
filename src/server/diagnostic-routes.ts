import type { Diagnostics } from "./diagnostics";
import { ServiceError } from "./http";
import { assertLocalRequest, localResponse } from "./local-boundary";

/** @id CODE-DIAG-ROUTES @implements REQ-DIAG-001 */
export function diagnosticRoutes(diagnostics: Diagnostics) {
  return async (request: Request): Promise<Response> => {
    try {
      assertLocalRequest(request);
      if (new URL(request.url).pathname !== "/api/readiness")
        throw new ServiceError(404, "ROUTE_NOT_FOUND");
      if (request.method !== "GET")
        return localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
      return localResponse(await diagnostics.readiness());
    } catch (error) {
      if (error instanceof ServiceError)
        return localResponse({ code: error.code }, error.status);
      console.error("DIAGNOSTIC_ROUTE_FAILED");
      return localResponse({ code: "INTERNAL_ERROR" }, 500);
    }
  };
}
