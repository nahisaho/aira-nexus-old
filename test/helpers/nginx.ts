import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type IncomingMessage } from "node:http";
import { createServer as createSocket } from "node:net";
import { networkInterfaces } from "node:os";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { resolve } from "node:path";

export function lanAddress() {
  const found = Object.values(networkInterfaces())
    .flatMap((values) => values ?? [])
    .find(
      (info) =>
        !info.internal &&
        info.family === "IPv4" &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(info.address),
    );
  assert.ok(found, "LAN tests require an assigned RFC1918 IPv4 interface");
  return found.address;
}

export async function availablePort(host: string) {
  const lease = createSocket();
  lease.listen(0, host);
  await once(lease, "listening");
  const address = lease.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done, reject) =>
    lease.close((error) => (error ? reject(error) : done())),
  );
  return port;
}

export function command(args: string[], env: Partial<NodeJS.ProcessEnv>) {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], {
    cwd: resolve("."),
    env: { ...process.env, ...env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  let result:
    { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.stdout.on("data", (chunk) => (log += String(chunk)));
  child.stderr.on("data", (chunk) => (log += String(chunk)));
  const done = new Promise<void>((finish, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      result = { code, signal };
      finish();
    });
  });
  async function until(predicate: () => boolean, label: string) {
    const deadline = Date.now() + 60_000;
    while (!predicate() && !result && Date.now() < deadline) await wait(20);
    assert.ok(predicate(), `${label}\n${log}`);
  }
  return {
    child,
    done,
    get log() {
      return log;
    },
    get result() {
      return result;
    },
    ready(marker: string) {
      return until(() => log.includes(marker), marker);
    },
    async stop() {
      if (!result) child.kill("SIGTERM");
      await until(() => Boolean(result), "OWNED_CHILD_STOP_TIMEOUT");
      await done;
    },
  };
}

export function send(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
    localAddress?: string;
  } = {},
) {
  const { body, ...rest } = options;
  return new Promise<IncomingMessage>((done, reject) => {
    const req = request(
      url,
      { ...rest, signal: AbortSignal.timeout(10_000) },
      done,
    );
    req.once("error", reject);
    req.end(body);
  });
}

export async function text(response: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

export async function closeServer(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}

export async function stopRaw(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  child.kill("SIGQUIT");
  await ended;
}
