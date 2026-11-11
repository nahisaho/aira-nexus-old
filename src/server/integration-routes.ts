import type { IntegrationCatalog } from "./integration-catalog";
import { assertLocalRequest, readJson, localResponse } from "./local-boundary";
import { ServiceError } from "./http";

/** @id CODE-CAT-ROUTES @implements REQ-CAT-001 REQ-CAT-002 REQ-CAT-003 */
export function integrationRoutes(catalog: IntegrationCatalog) {
  return async (request: Request): Promise<Response> => {
    try {
      assertLocalRequest(request);
      const path = new URL(request.url).pathname;
      const global = path === "/api/integrations";
      const match = /^\/api\/projects\/([^/]+)\/integrations$/.exec(path);
      if (!global && !match) throw new ServiceError(404, "ROUTE_NOT_FOUND");
      if (global && request.method === "GET")
        return localResponse(catalog.registry());
      if (match) {
        let projectId: string;
        try {
          projectId = decodeURIComponent(match[1]);
        } catch (error) {
          if (error instanceof URIError)
            throw new ServiceError(400, "INVALID_ID");
          throw error;
        }
        if (request.method === "GET")
          return localResponse(await catalog.get("local", projectId));
        if (request.method === "PUT")
          return localResponse(
            await catalog.save("local", projectId, await readJson(request)),
          );
      }
      const response = localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
      response.headers.set("Allow", global ? "GET" : "GET, PUT");
      return response;
    } catch (error) {
      if (error instanceof ServiceError)
        return localResponse({ code: error.code }, error.status);
      console.error("INTEGRATION_ROUTE_FAILED");
      return localResponse({ code: "INTERNAL_ERROR" }, 500);
    }
  };
}
