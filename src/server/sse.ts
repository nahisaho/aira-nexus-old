import type { Job } from "./operations";
import { ServiceError } from "./http";
import { setTimeout as wait } from "node:timers/promises";

export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_TURN_EVENT_BYTES = 2 * 1024 * 1024;
export const MAX_TURN_EVENTS = 256;
export type TurnEvent =
  | { kind: "partial"; text: string }
  | { kind: "tool" | "proposal"; payload: unknown };
export interface StoredEvent {
  sequence: number;
  kind: TurnEvent["kind"];
  payload: unknown;
}
export interface TurnProjection {
  id: string;
  jobId: string;
  state: Job["state"];
  response: string;
  events: StoredEvent[];
  lastSequence: number;
}
export interface StreamOptions {
  after?: number;
  signal?: AbortSignal;
  pollMs?: number;
}

/** @id CODE-SESSION-SSE @implements REQ-SESSION-002 */
export function streamEvents(
  read: (after: number) => Promise<TurnProjection>,
  initial: TurnProjection,
  options: StreamOptions = {},
): Response {
  let cursor = options.after ?? 0;
  const pollMs = options.pollMs ?? 100;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    cursor > MAX_TURN_EVENTS ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 10 ||
    pollMs > 1000
  ) {
    throw new ServiceError(400, "INVALID_STREAM_OPTIONS");
  }
  const abort = new AbortController();
  const requestAbort = () => abort.abort();
  options.signal?.addEventListener("abort", requestAbort, { once: true });
  if (options.signal?.aborted) abort.abort();
  const cleanup = () =>
    options.signal?.removeEventListener("abort", requestAbort);
  const encoder = new TextEncoder();
  let snapshot = initial;
  let statusSent = false;
  let cancelled = false;
  const encode = (name: string, data: unknown, id?: number) =>
    encoder.encode(
      `${id === undefined ? "" : `id: ${id}\n`}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!abort.signal.aborted) {
          if (!statusSent) {
            statusSent = true;
            controller.enqueue(
              encode("status", {
                turnId: initial.id,
                jobId: initial.jobId,
                state: snapshot.state,
                completed: false,
              }),
            );
            return;
          }
          const event = snapshot.events.find(
            (value) => value.sequence > cursor,
          );
          if (event) {
            cursor = event.sequence;
            controller.enqueue(
              encode(
                event.kind,
                { payload: event.payload, completed: false },
                cursor,
              ),
            );
            return;
          }
          if (snapshot.state !== "queued" && snapshot.state !== "running") {
            controller.enqueue(
              encode(snapshot.state, {
                turnId: snapshot.id,
                jobId: snapshot.jobId,
                state: snapshot.state,
                completed: snapshot.state === "completed",
              }),
            );
            controller.close();
            cleanup();
            return;
          }
          await wait(pollMs, undefined, { signal: abort.signal });
          snapshot = await read(cursor);
        }
        if (!cancelled) controller.close();
        cleanup();
      } catch (error) {
        if (abort.signal.aborted) {
          if (!cancelled) controller.close();
        } else {
          controller.error(error);
        }
        cleanup();
      }
    },
    cancel() {
      cancelled = true;
      abort.abort();
      cleanup();
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
