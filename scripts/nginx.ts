import { resolve } from "node:path";
import { installNginx, startNginx } from "../src/server/nginx";
import { publicOrigin } from "../src/server/trusted-lan";

let proxy: Awaited<ReturnType<typeof startNginx>> | undefined;
let stopRequested = false;
const startup = new AbortController();
function stop() {
  stopRequested = true;
  startup.abort();
  if (proxy)
    void proxy.close().catch((error) => {
      console.error(
        error instanceof Error ? error.message : "NGINX_STOP_FAILED",
      );
      process.exitCode = 1;
    });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

/** @id CODE-LAN-COMMAND @implements REQ-LAN-001 REQ-LAN-002 */
async function main() {
  const directory = resolve(process.env.AIRA_PROXY_DIR ?? ".aira-proxy");
  const args = process.argv.slice(2);
  if (
    args[0] === "install" &&
    (args.length === 1 || (args.length === 3 && args[1] === "--archive"))
  ) {
    await installNginx(directory, args[2]);
    console.log("AIRA Nginx prerequisite installed privately");
    return;
  }
  if (args.length !== 1 || args[0] !== "start")
    throw new Error("NGINX_COMMAND_REQUIRED");
  const origin = publicOrigin();
  if (!origin) throw new Error("PUBLIC_ORIGIN_REQUIRED");
  if (stopRequested) return;
  proxy = await startNginx(
    directory,
    origin,
    Number(process.env.PORT ?? "3000"),
    startup.signal,
  );
  if (stopRequested) await proxy.close();
  else {
    console.log(`AIRA Nginx ${origin.origin}`);
    await proxy.exited;
  }
}
await main().catch((error: unknown) => {
  if (stopRequested && error === startup.signal.reason) {
    console.error("NGINX_START_CANCELLED");
    return;
  }
  console.error(
    error instanceof Error ? error.message : "NGINX_COMMAND_FAILED",
  );
  process.exitCode = 1;
});
