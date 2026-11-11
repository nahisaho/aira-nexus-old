import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import next from "next";
import { publicOrigin } from "../src/server/trusted-lan";
import { ServiceError } from "../src/server/http";
import { startDatabase } from "../src/server/db-container";
import { migrate } from "./migrate";
import {
  createApplication,
  installApplication,
  type Application,
} from "../src/server/application";

const state = resolve(process.env.AIRA_STATE_DIR ?? ".aira");
let application: Application | undefined;
let web: ReturnType<typeof next> | undefined;
let server: Server | undefined;
let stopping: Promise<void> | undefined;
let stopRequested = false;
function requestStop() {
  stopRequested = true;
  void stop();
}
process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);
async function stop() {
  return (stopping ??= (async () => {
    // The top-level handler reports startup failures; drain initialization before closing its resources.
    await Promise.allSettled([starting]);
    const results = await Promise.allSettled([
      application?.close(),
      server &&
        new Promise<void>((done, reject) =>
          server!.close((error) => (error ? reject(error) : done())),
        ),
    ]);
    try {
      await web?.close();
    } catch {
      console.error("WEB_SERVER_CLEANUP_FAILED");
      process.exitCode = 1;
    }
    if (results.some((result) => result.status === "rejected")) {
      console.error("APPLICATION_CLEANUP_FAILED");
      process.exitCode = 1;
    }
  })());
}
async function start() {
  publicOrigin();
  const { credentials } = await startDatabase(
    state,
    process.argv.includes("--initialize"),
  );
  if (stopRequested) return;
  await migrate(state, credentials);
  if (stopRequested) return;
  application = await createApplication({ state });
  if (stopRequested) return;
  installApplication(application);
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error("INVALID_LISTEN_PORT");
  web = next({
    dev: process.argv.includes("--dev"),
    hostname: "127.0.0.1",
    port,
  });
  await web.prepare();
  if (stopRequested) return;
  server = createServer(web.getRequestHandler());
  await new Promise<void>((done, reject) => {
    server!.once("error", reject);
    server!.listen(port, "127.0.0.1", done);
  });
  if (stopRequested) return;
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("INVALID_LISTEN_ADDRESS");
  console.log(`AIRA Nexus http://127.0.0.1:${address.port}`);
  server.once("error", () => {
    console.error("WEB_SERVER_START_FAILED");
    process.exitCode = 1;
    requestStop();
  });
}
const starting = start();
await starting.catch(async (error: unknown) => {
  if (error instanceof ServiceError && error.code === "INVALID_PUBLIC_ORIGIN")
    console.error(error.code);
  console.error("APPLICATION_START_FAILED");
  process.exitCode = 1;
  await stop();
});
