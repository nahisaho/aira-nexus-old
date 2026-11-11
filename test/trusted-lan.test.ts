import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { chromium } from "@playwright/test";
import { publicOrigin, type PublicOrigin } from "../src/server/trusted-lan";
import { installNginx, nginxConfig } from "../src/server/nginx";
import { testDatabase } from "./helpers/database";
import { connectDatabase } from "../src/server/database";
import {
  availablePort,
  closeServer,
  command,
  lanAddress,
  send,
  stopRaw,
  text,
} from "./helpers/nginx";

const archive = resolve(".aira-proxy/package.deb");
async function temporary() {
  await mkdir(resolve(".scratch"), { recursive: true, mode: 0o700 });
  return mkdtemp(resolve(".scratch/nginx-test-"));
}
function selected(address: string, port: number): PublicOrigin {
  return {
    origin: `http://${address}:${port}`,
    host: `${address}:${port}`,
    address,
    port,
  };
}

/** @id TEST-LAN-001 @verifies REQ-LAN-001 */
test(
  "TEST-LAN-001 private pinned Nginx serves real loopback workspace and preserves owned lifecycle",
  { timeout: 120000 },
  async (t) => {
    const cleanup: (() => Promise<unknown>)[] = [];
    async function finished(child: ReturnType<typeof command>) {
      const deadline = Date.now() + 30_000;
      while (!child.result && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 20));
      assert.ok(
        child.result,
        `command must refuse rather than keep serving\n${child.log}`,
      );
      await child.done;
    }
    t.after(async () => {
      for (const action of cleanup.reverse()) await action();
    });
    const root = await temporary();
    cleanup.push(() => rm(root, { recursive: true }));
    const directory = join(root, "proxy");
    await assert.doesNotReject(() => installNginx(directory, archive));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const corrupt = join(root, "corrupt.deb");
    await writeFile(corrupt, Buffer.from("not the approved archive"));
    await assert.rejects(
      () => installNginx(join(root, "bad-install"), corrupt),
      /NGINX_ARCHIVE_HASH/,
    );
    const interrupted = join(root, "interrupted-install");
    const { promises } = await import("node:fs");
    const { syncBuiltinESMExports } = await import("node:module");
    const originalWrite = promises.writeFile;
    let injected = false;
    const writeFault = t.mock.method(
      promises,
      "writeFile",
      async (...args: Parameters<typeof originalWrite>) => {
        const path = args[0];
        if (
          typeof path === "string" &&
          path.startsWith(interrupted + "/") &&
          path.endsWith("/installed.json")
        ) {
          injected = true;
          throw Object.assign(new Error("CONTROLLED_MANIFEST_WRITE"), {
            code: "EACCES",
          });
        }
        return originalWrite(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(() => installNginx(interrupted, archive), {
        code: "EACCES",
      });
    } finally {
      writeFault.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    await assert.rejects(stat(join(interrupted, "installation")), {
      code: "ENOENT",
    });
    await assert.doesNotReject(() => installNginx(interrupted, archive));
    const db = await testDatabase();
    cleanup.push(() => db.cleanup());
    const address = lanAddress();
    const port = await availablePort("127.0.0.1");
    const origin = selected(address, await availablePort(address));
    const env = {
      AIRA_STATE_DIR: db.state,
      AIRA_PROXY_DIR: directory,
      AIRA_PUBLIC_ORIGIN: origin.origin,
      PORT: String(port),
    };
    const app = command(["scripts/start.ts"], env);
    cleanup.push(() => app.stop());
    await app.ready(`AIRA Nexus http://127.0.0.1:${port}`);
    const local = `http://127.0.0.1:${port}`;
    const created = await fetch(local + "/api/projects", {
      method: "POST",
      headers: { Origin: local, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Nginx retained witness", description: "" }),
    });
    assert.equal(created.status, 201);
    const project = await created.json();
    const observer = await connectDatabase(
      db.state,
      db.credentials,
      "bootstrap",
    );
    cleanup.push(() => observer.end());
    assert.equal(
      (
        await observer.query(
          "SELECT pg_try_advisory_lock(918273645) AS acquired",
        )
      ).rows[0].acquired,
      false,
    );
    const proxy = command(["scripts/nginx.ts", "start"], env);
    cleanup.push(() => proxy.stop());
    await proxy.ready(`AIRA Nginx ${origin.origin}`);
    const page = await fetch(origin.origin);
    assert.equal(page.status, 200);
    const html = await page.text();
    const asset = /src="([^"]+\.js(?:\?[^"]*)?)"/.exec(html)?.[1];
    assert.ok(asset);
    assert.equal((await fetch(new URL(asset, origin.origin))).status, 200);
    const browser = await chromium.launch({ headless: true });
    cleanup.push(() => browser.close());
    const tab = await browser.newPage();
    await tab.goto(origin.origin);
    await tab
      .getByText("Nginx retained witness", { exact: true })
      .waitFor({ state: "visible" });
    assert.equal(
      await tab
        .getByText("Nginx retained witness", { exact: true })
        .isVisible(),
      true,
    );
    const duplicate = command(["scripts/nginx.ts", "start"], env);
    cleanup.push(() => duplicate.stop());
    await finished(duplicate);
    assert.notEqual(duplicate.result?.code, 0);
    assert.match(duplicate.log, /PROXY_ALREADY_OWNED/);
    const foreign = await send(origin.origin + "/api/projects", {
      headers: { Origin: "http://evil.invalid" },
    });
    assert.equal(foreign.statusCode, 403);
    await text(foreign);
    await proxy.stop();
    assert.equal(proxy.result?.code, 0, proxy.log);
    await assert.rejects(stat(join(directory, "owner.lock")), {
      code: "ENOENT",
    });
    await writeFile(
      join(directory, "owner.lock"),
      '{"stale":"must refuse without signalling"}',
      { mode: 0o600 },
    );
    const stale = command(["scripts/nginx.ts", "start"], env);
    cleanup.push(() => stale.stop());
    await finished(stale);
    assert.notEqual(stale.result?.code, 0);
    assert.match(stale.log, /PROXY_ALREADY_OWNED/);
    await rm(join(directory, "owner.lock"));
    for (const override of [
      { PORT: "0" },
      { PORT: String(await availablePort("127.0.0.1")) },
    ]) {
      const invalid = command(["scripts/nginx.ts", "start"], {
        ...env,
        ...override,
      });
      cleanup.push(() => invalid.stop());
      await finished(invalid);
      assert.notEqual(invalid.result?.code, 0);
      await assert.rejects(stat(join(directory, "owner.lock")), {
        code: "ENOENT",
      });
    }
    await app.stop();
    assert.equal(app.result?.code, 0, app.log);
    assert.equal(
      (
        await observer.query(
          "SELECT pg_try_advisory_lock(918273645) AS acquired",
        )
      ).rows[0].acquired,
      true,
    );
    await observer.query("SELECT pg_advisory_unlock(918273645)");
    const restarted = command(["scripts/start.ts"], {
      ...env,
      AIRA_PUBLIC_ORIGIN: undefined,
    });
    cleanup.push(() => restarted.stop());
    await restarted.ready(`AIRA Nexus http://127.0.0.1:${port}`);
    const list = await (await fetch(local + "/api/projects")).json();
    assert.ok(
      list.projects.some((item: { id: string }) => item.id === project.id),
    );
    const unconfigured = command(["scripts/nginx.ts", "start"], env);
    cleanup.push(() => unconfigured.stop());
    await finished(unconfigured);
    assert.notEqual(unconfigured.result?.code, 0);
    assert.match(unconfigured.log, /PROXY_UPSTREAM_UNAVAILABLE/);
  },
);

/** @id TEST-LAN-002 @verifies REQ-LAN-002 */
test(
  "TEST-LAN-002 canonical assigned private origin and fail-before-state controls",
  { timeout: 120000 },
  async (t) => {
    assert.doesNotThrow(() =>
      assert.equal(publicOrigin(undefined, []), undefined),
    );
    for (const address of [
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.11.10",
    ]) {
      const value = `http://${address}:3000`;
      assert.deepEqual(publicOrigin(value, [address]), selected(address, 3000));
    }
    for (const value of [
      "",
      " ",
      "http://0.0.0.0:3000",
      "http://127.0.0.1:3000",
      "http://169.254.53.100:3000",
      "http://100.64.0.1:3000",
      "http://203.0.113.1:3000",
      "http://172.15.0.1:3000",
      "http://172.32.0.1:3000",
      "http://192.168.011.10:3000",
      "http://192.168.11.10:03000",
      " http://192.168.11.10:3000",
      "http://[::ffff:192.168.11.10]:3000",
      "http://192.168.11.10",
      "http://192.168.11.10:0",
      "http://192.168.11.10:1023",
      "http://192.168.11.10:65536",
      "https://192.168.11.10:3000",
      "http://user@192.168.11.10:3000",
      "http://192.168.11.10:3000/",
      "http://192.168.11.10:3000/path",
      "http://192.168.11.10:3000?x",
      "http://192.168.11.10:3000#x",
    ]) {
      assert.throws(
        () =>
          publicOrigin(value, [
            "192.168.11.10",
            "203.0.113.1",
            "169.254.53.100",
            "100.64.0.1",
            "172.15.0.1",
            "172.32.0.1",
            "192.168.011.10",
          ]),
        /INVALID_PUBLIC_ORIGIN/,
        value,
      );
    }
    assert.throws(
      () => publicOrigin("http://192.168.11.10:3000", []),
      /INVALID_PUBLIC_ORIGIN/,
    );
    const root = await temporary();
    t.after(() => rm(root, { recursive: true }));
    let stateNumber = 0;
    for (const value of ["", "http://8.8.8.8:3000"]) {
      for (const args of [
        ["scripts/start.ts"],
        ["scripts/nginx.ts", "start"],
      ]) {
        const state = join(root, `state-${stateNumber++}`);
        const result = command(args, {
          AIRA_STATE_DIR: state,
          AIRA_PROXY_DIR: state,
          AIRA_PUBLIC_ORIGIN: value,
        });
        t.after(() => result.stop());
        await result.done;
        assert.notEqual(result.result?.code, 0);
        assert.match(result.log, /INVALID_PUBLIC_ORIGIN/);
        await assert.rejects(stat(state), { code: "ENOENT" });
      }
    }
  },
);

/** @id TEST-LAN-003 @verifies REQ-LAN-003 */
test(
  "TEST-LAN-003 real Nginx headers, peer ACL, bidirectional streaming and body caps",
  { timeout: 120000 },
  async (t) => {
    const root = await temporary();
    const cleanup: (() => Promise<unknown>)[] = [
      () => rm(root, { recursive: true }),
    ];
    t.after(async () => {
      for (const action of cleanup.reverse()) await action();
    });
    const origin = selected(lanAddress(), await availablePort(lanAddress()));
    let configuration = "";
    assert.doesNotThrow(() => {
      configuration = nginxConfig(origin, 3000);
    });
    const directory = join(root, "proxy");
    await installNginx(directory, archive);
    let held: import("node:http").ServerResponse | undefined;
    let uploads = 0;
    const server = createServer((req, res) => {
      if (req.url === "/events") {
        held = res;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: first\n\n");
      } else if (req.url === "/release") {
        held?.end("data: final\n\n");
        res.end("released");
      } else if (req.url === "/early") {
        res.writeHead(409);
        res.end("early");
        req.resume();
      } else if (req.url === "/upload") {
        uploads++;
        let size = 0;
        req.on("data", (chunk) => (size += chunk.length));
        req.on("end", () => res.end(String(size)));
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.headers));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => closeServer(server));
    const backend = server.address();
    assert.ok(backend && typeof backend !== "string");
    configuration = nginxConfig(origin, backend.port);
    await writeFile(join(directory, "nginx.conf"), configuration, {
      mode: 0o600,
    });
    const child = spawn(
      join(directory, "installation/usr/sbin/nginx"),
      ["-p", directory + "/", "-c", "nginx.conf", "-g", "daemon off;"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    cleanup.push(() => stopRaw(child));
    let log = "";
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(new Error("NGINX_TEST_START_TIMEOUT\n" + log)),
        15_000,
      );
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(log));
      });
      child.stderr.on("data", (chunk) => {
        log += String(chunk);
        if (/start worker process \d+/.test(log)) {
          clearTimeout(timer);
          done();
        }
      });
    });
    const headers = { Origin: origin.origin };
    const echo = await send(origin.origin + "/headers", {
      headers: {
        ...headers,
        Forwarded: "host=evil.invalid",
        "X-Forwarded-Host": "evil.invalid",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "203.0.113.1",
        "X-Forwarded-Port": "443",
        "X-Forwarded-Server": "evil.invalid",
      },
    });
    assert.equal(echo.statusCode, 200);
    const observed = JSON.parse(await text(echo));
    assert.equal(observed.host, origin.host);
    assert.equal(observed.origin, origin.origin);
    for (const key of [
      "forwarded",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-for",
      "x-forwarded-port",
      "x-forwarded-server",
    ])
      assert.equal(observed[key], undefined);
    const cross = await send(origin.origin, {
      headers: { Origin: "http://evil.invalid" },
    });
    assert.equal(JSON.parse(await text(cross)).origin, "http://evil.invalid");
    for (const localAddress of [undefined, "127.0.0.2"]) {
      for (const Host of [origin.host, "evil.invalid"]) {
        if (!localAddress && Host === origin.host) continue;
        const denied = await send(origin.origin, {
          localAddress,
          headers: { Host, "X-Forwarded-For": origin.address },
        });
        assert.equal(denied.statusCode, 403);
        await text(denied);
      }
    }
    await assert.doesNotReject(async () => {
      const event = await send(origin.origin + "/events");
      const reader = event[Symbol.asyncIterator]();
      const first = await reader.next();
      assert.equal(first.done, false);
      assert.match(Buffer.from(first.value).toString(), /data: first/);
      assert.equal(held?.writableEnded, false);
      await text(await send(origin.origin + "/release"));
      while (!(await reader.next()).done) {}
    }, "SSE must arrive before backend completion, within the request deadline");
    const body = Buffer.alloc(2 * 1024 * 1024, 97);
    const upload = await send(origin.origin + "/upload", {
      method: "POST",
      headers: { "Content-Length": String(body.length) },
      body,
    });
    assert.equal(upload.statusCode, 200);
    assert.equal(await text(upload), String(body.length));
    const before = uploads;
    const tooLarge = await send(origin.origin + "/upload", {
      method: "POST",
      headers: { "Content-Length": String(100 * 1024 * 1024 + 1) },
    });
    assert.equal(tooLarge.statusCode, 413);
    await text(tooLarge);
    assert.equal(uploads, before);
    let ended = false;
    await assert.doesNotReject(
      () =>
        new Promise<void>((done, reject) => {
          const req = request(
            origin.origin + "/early",
            {
              method: "POST",
              headers: { "Content-Length": "1048576" },
              signal: AbortSignal.timeout(10_000),
            },
            async (res) => {
              try {
                assert.equal(res.statusCode, 409);
                assert.equal(ended, false);
                assert.equal(await text(res), "early");
                req.destroy();
                done();
              } catch (error) {
                reject(error);
              }
            },
          );
          req.once("error", reject);
          req.write("x");
          ended = req.writableEnded;
        }),
      "upstream refusal must arrive before the upload body finishes",
    );
  },
);
