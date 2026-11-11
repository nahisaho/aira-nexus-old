import type { Notebooks } from "./notebooks";
import { assertLocalRequest, readJson, localResponse } from "./local-boundary";
import { ServiceError } from "./http";
/** @id CODE-NOTE-ROUTES @implements REQ-NOTE-001 REQ-NOTE-002 REQ-NOTE-003 REQ-XCH-001 REQ-NH-003 REQ-NH-004 REQ-NH-006 */
export function notebookRoutes(notebooks: Notebooks) {
  return async (request: Request): Promise<Response> => {
    try {
      assertLocalRequest(request);
      const url = new URL(request.url);
      const journal = /^\/api\/projects\/([^/]+)\/lab-note$/.exec(url.pathname);
      if (journal)
        return request.method === "GET"
          ? localResponse(await notebooks.labNote("local", journal[1]))
          : localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
      const history =
        /^\/api\/projects\/([^/]+)\/notebooks\/([^/]+)\/versions(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(
          url.pathname,
        );
      if (history) {
        const [, project, notebook, selected, action] = history;
        if (selected === "git") {
          if (action !== "retry" && action !== "rebuild")
            throw new ServiceError(404, "ROUTE_NOT_FOUND");
          if (request.method !== "POST")
            return localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
          const input = await readJson(request);
          return localResponse(
            action === "retry"
              ? await notebooks.versions.retry(
                  "local",
                  project,
                  notebook,
                  input,
                )
              : await notebooks.versions.rebuild(
                  "local",
                  project,
                  notebook,
                  input,
                ),
            202,
          );
        }
        if (!selected && request.method === "GET")
          return localResponse(
            await notebooks.versions.list(
              "local",
              project,
              notebook,
              url.searchParams,
            ),
          );
        if (selected && !action && request.method === "GET")
          return localResponse(
            await notebooks.versions.detail(
              "local",
              project,
              notebook,
              selected,
            ),
          );
        if (selected && action === "diff" && request.method === "GET") {
          if (url.searchParams.getAll("against").length !== 1)
            throw new ServiceError(400, "INVALID_HISTORY_COMPARISON");
          return localResponse(
            await notebooks.versions.diff(
              "local",
              project,
              notebook,
              selected,
              url.searchParams.get("against"),
            ),
          );
        }
        if (selected && action === "restore" && request.method === "POST")
          return localResponse(
            await notebooks.versions.restore(
              "local",
              project,
              notebook,
              selected,
              await readJson(request),
            ),
          );
        if (action && action !== "diff" && action !== "restore")
          throw new ServiceError(404, "ROUTE_NOT_FOUND");
        return localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
      }
      const match =
        /^\/api\/projects\/([^/]+)\/notebooks(?:\/([^/]+)(\/(?:history|imported))?)?$/.exec(
          url.pathname,
        );
      if (!match) throw new ServiceError(404, "ROUTE_NOT_FOUND");
      const [, projectId, id, suffix] = match;
      if (!id && request.method === "GET")
        return localResponse({
          notebooks: await notebooks.list("local", projectId),
        });
      if (!id && request.method === "POST")
        return localResponse(
          await notebooks.create("local", projectId, await readJson(request)),
          201,
        );
      if (id && request.method === "GET")
        return localResponse(
          suffix === "/imported"
            ? await notebooks.imported("local", projectId, id)
            : suffix === "/history"
              ? { runs: await notebooks.history("local", projectId, id) }
              : await notebooks.get("local", projectId, id),
        );
      if (id && !suffix && request.method === "PATCH")
        return localResponse(
          await notebooks.patch(
            "local",
            projectId,
            id,
            await readJson(request),
          ),
        );
      if (id && !suffix && request.method === "PUT")
        return localResponse(
          await notebooks.save("local", projectId, id, await readJson(request)),
        );
      return localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
    } catch (error) {
      if (error instanceof ServiceError)
        return localResponse({ code: error.code }, error.status);
      console.error("NOTEBOOK_ROUTE_FAILED");
      return localResponse({ code: "INTERNAL_ERROR" }, 500);
    }
  };
}
