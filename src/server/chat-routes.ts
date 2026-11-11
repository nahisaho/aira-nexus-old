import type { Chat } from "./chat";
import { assertLocalRequest, readJson, localResponse } from "./local-boundary";
import { ServiceError } from "./http";

/** @id CODE-CHAT-ROUTES @implements REQ-CHAT-001 REQ-CHAT-002 */
export function chatRoutes(chat: Chat) {
  return async (request: Request): Promise<Response> => {
    try {
      assertLocalRequest(request);
      const url = new URL(request.url);
      const match = /^\/api\/projects\/([^/]+)\/chat(?:\/(context|turns)(?:\/([^/]+)(\/events)?)?)?$/.exec(url.pathname);
      if (!match) throw new ServiceError(404, "ROUTE_NOT_FOUND");
      const [, projectId, section, turnId, events] = match;
      if (!section && request.method === "GET")
        return localResponse(await chat.open("local", projectId));
      if (section === "context" && !turnId && request.method === "POST")
        return localResponse(await chat.preview("local", projectId, await readJson(request)));
      if (section === "turns" && !turnId && request.method === "POST")
        return localResponse(await chat.submit("local", projectId, await readJson(request)));
      if (section === "turns" && turnId && request.method === "GET") {
        const cursor = request.headers.get("Last-Event-ID") ?? url.searchParams.get("after") ?? "0";
        if (!/^(0|[1-9][0-9]*)$/.test(cursor))
          throw new ServiceError(400, "INVALID_EVENT_CURSOR");
        if (events) return chat.events("local", projectId, turnId, { after: Number(cursor), signal: request.signal });
        return localResponse(await chat.turn("local", projectId, turnId, Number(cursor)));
      }
      return localResponse({ code: "METHOD_NOT_ALLOWED" }, 405);
    } catch (error) {
      if (error instanceof ServiceError)
        return localResponse({ code: error.code }, error.status);
      console.error("CHAT_ROUTE_FAILED");
      return localResponse({ code: "INTERNAL_ERROR" }, 500);
    }
  };
}
