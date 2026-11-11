import type { Proposals } from "./proposals";
import type { Confirmations } from "./confirmations";
import { assertLocalRequest, readJson, localResponse } from "./local-boundary";
import { ServiceError } from "./http";
/** @id CODE-PROP-ROUTES @implements REQ-PROP-001 REQ-PROP-002 REQ-PROP-003 REQ-PROP-004 */
export function proposalRoutes(
  proposals: Proposals,
  confirmations: Confirmations,
) {
  return async (request: Request): Promise<Response> => {
    try {
      assertLocalRequest(request);
      const path = new URL(request.url).pathname;
      const proposal =
        /^\/api\/projects\/([^/]+)\/proposals(?:\/([^/]+)(?:\/(accept|reject))?)?$/.exec(
          path,
        );
      if (proposal) {
        const [, projectId, id, action] = proposal;
        if (!id && request.method === "GET")
          return localResponse({
            proposals: await proposals.list("local", projectId),
          });
        if (!id && request.method === "POST")
          return localResponse(
            await proposals.propose(
              "local",
              projectId,
              await readJson(request),
            ),
            201,
          );
        if (id && !action && request.method === "GET")
          return localResponse(await proposals.get("local", projectId, id));
        if (id && action === "accept" && request.method === "POST")
          return localResponse(
            await proposals.accept(
              "local",
              projectId,
              id,
              await readJson(request),
            ),
          );
        if (id && action === "reject" && request.method === "POST")
          return localResponse(await proposals.reject("local", projectId, id));
        return localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
      }
      const confirmation =
        /^\/api\/projects\/([^/]+)\/confirmations\/(?:(execution|disclosure)|admit\/(execution|disclosure)|([^/]+))$/.exec(
          path,
        );
      if (!confirmation) throw new ServiceError(404, "ROUTE_NOT_FOUND");
      const [, projectId, prepare, admit, id] = confirmation;
      if (request.method === "POST" && prepare)
        return localResponse(
          prepare === "execution"
            ? await confirmations.prepareExecution(
                "local",
                projectId,
                await readJson(request),
              )
            : await confirmations.prepareDisclosure(
                "local",
                projectId,
                await readJson(request),
              ),
          201,
        );
      if (request.method === "POST" && admit)
        return localResponse(
          await confirmations.admit(
            "local",
            projectId,
            admit === "execution" ? "execution" : "disclosure",
            await readJson(request),
          ),
        );
      if (id && request.method === "GET")
        return localResponse(await confirmations.get("local", projectId, id));
      if (id && request.method === "DELETE") {
        await confirmations.deny("local", projectId, id);
        return localResponse({ revoked: true });
      }
      return localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
    } catch (error) {
      if (error instanceof ServiceError)
        return localResponse({ code: error.code }, error.status);
      console.error("PROPOSAL_ROUTE_FAILED");
      return localResponse({ code: "INTERNAL_ERROR" }, 500);
    }
  };
}
