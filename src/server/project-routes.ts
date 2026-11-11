import type { Projects } from "./projects";
import { assertLocalRequest, readJson, localResponse } from "./local-boundary";
import { ServiceError } from "./http";
import { z } from "zod";

/** @id CODE-PROJECT-ROUTES @implements REQ-PROJECT-001 REQ-PROJECT-002 REQ-PROJECT-003 REQ-PROJECT-004 REQ-PROJECT-005 REQ-VIS-001 REQ-VIS-002 REQ-VIS-003 */
export function projectRoutes(projects: Projects) {
  return async (request: Request): Promise<Response> => {
    try {
      assertLocalRequest(request);
      const match =
        /^\/api\/projects(?:\/([^/]+)(\/(?:archive|hide|restore|pin|visit))?)?$/.exec(
          new URL(request.url).pathname,
        );
      if (!match) throw new ServiceError(404, "ROUTE_NOT_FOUND");
      let id: string | undefined;
      try {
        id = match[1] === undefined ? undefined : decodeURIComponent(match[1]);
      } catch (error) {
        if (error instanceof URIError)
          throw new ServiceError(400, "INVALID_ID");
        throw error;
      }
      const actor = "local";
      const deletedList = id === "deleted" && !match[2];
      if (deletedList) {
        if (request.method === "GET")
          return localResponse({ projects: await projects.deleted(actor) });
      } else if (!id) {
        if (request.method === "GET")
          return localResponse({ projects: await projects.list(actor) });
        if (request.method === "POST")
          return localResponse(
            await projects.create(actor, await readJson(request)),
            201,
          );
      } else if (match[2]) {
        if (request.method === "POST") {
          if (match[2] === "/pin")
            return localResponse(
              await projects.pin(actor, id, await readJson(request)),
            );
          if (match[2] === "/visit")
            return localResponse(
              await projects.visit(actor, id, await readJson(request)),
            );
          const parsed = z
            .object({ revision: z.unknown() })
            .strict()
            .safeParse(await readJson(request));
          if (!parsed.success)
            throw new ServiceError(400, "INVALID_PROJECT_INPUT");
          const result =
            match[2] === "/hide"
              ? await projects.hide(actor, id, parsed.data.revision)
              : match[2] === "/restore"
                ? await projects.restore(actor, id, parsed.data.revision)
                : await projects.archive(actor, id, parsed.data.revision);
          return localResponse(result);
        }
      } else {
        if (request.method === "GET")
          return localResponse(await projects.get(actor, id));
        if (request.method === "PATCH")
          return localResponse(
            await projects.edit(actor, id, await readJson(request)),
          );
      }
      const response = localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
      response.headers.set(
        "Allow",
        deletedList
          ? "GET"
          : !id
            ? "GET, POST"
            : match[2]
              ? "POST"
              : "GET, PATCH",
      );
      return response;
    } catch (error) {
      if (error instanceof ServiceError)
        return localResponse({ code: error.code }, error.status);
      console.error("PROJECT_ROUTE_FAILED");
      return localResponse({ code: "INTERNAL_ERROR" }, 500);
    }
  };
}
