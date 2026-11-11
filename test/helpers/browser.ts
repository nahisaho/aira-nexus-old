import { chromium, type Browser } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";

export async function browserFixture(
  handler: (request: Request) => Promise<Response>,
) {
  let browser: Browser | undefined;
  const server: Server = createServer(
    { joinDuplicateHeaders: true },
    (incoming, outgoing) => {
      void (async () => {
        const headers = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2)
          headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        const init = {
          method: incoming.method,
          headers,
          duplex: "half",
        };
        const iterator = incoming.iterator({ destroyOnReturn: false });
        const body = ["GET", "HEAD"].includes(incoming.method ?? "GET")
          ? undefined
          : new ReadableStream<Uint8Array>({
              async pull(controller) {
                const next = await iterator.next();
                if (next.done) controller.close();
                else if (next.value instanceof Uint8Array)
                  controller.enqueue(next.value);
                else controller.error(new Error("Unexpected HTTP body chunk"));
              },
              async cancel() {
                await iterator.return?.();
              },
            });
        const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
          ...init,
          ...(body ? { body } : {}),
        });
        const response = await handler(request);
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        async function* responseChunks() {
          const reader = response.body!.getReader();
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            await reader.cancel();
            reader.releaseLock();
          }
        }
        if (response.body)
          Readable.from(responseChunks())
            .on("error", (error) => outgoing.destroy(error))
            .pipe(outgoing);
        else outgoing.end();
      })().catch((error) => outgoing.destroy(error));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing owned loopback address");
  const port = address.port;
  try {
    browser = await chromium.launch();
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return {
    browser,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
