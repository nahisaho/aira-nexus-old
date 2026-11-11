import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { privateDirectory, privateFile } from "./credentials";
import { publicOrigin, type PublicOrigin } from "./trusted-lan";

export const NGINX_ARCHIVE_SHA256 =
  "190e602e4b54cf629c6f625ae1513241db404311c2af98720695b210a6dbe86b";
const archiveUrl =
  "https://security.ubuntu.com/ubuntu/pool/main/n/nginx/nginx_1.28.3-2ubuntu1.12_amd64.deb";
const execute = promisify(execFile);
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const binaryPath = (directory: string) =>
  join(directory, "installation/usr/sbin/nginx");

async function writePrivate(path: string, value: string) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
    await privateFile(path);
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
    );
  }
  try {
    await handle.writeFile(value);
  } finally {
    await handle.close();
  }
}

async function ownership(directory: string) {
  await privateDirectory(directory, true);
  const path = join(directory, "owner.lock");
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error("PROXY_ALREADY_OWNED");
    throw error;
  }
  const nonce = randomUUID();
  try {
    await handle.writeFile(JSON.stringify({ nonce, pid: process.pid }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return async () => {
    await privateFile(path);
    const owner: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !owner ||
      typeof owner !== "object" ||
      !("nonce" in owner) ||
      owner.nonce !== nonce
    )
      throw new Error("PROXY_OWNER_CHANGED");
    await rm(path);
  };
}

async function verifiedBinary(directory: string) {
  await privateDirectory(directory);
  await privateFile(join(directory, "installation/installed.json"));
  const installed: unknown = JSON.parse(
    await readFile(join(directory, "installation/installed.json"), "utf8"),
  );
  const binary = binaryPath(directory);
  const info = await lstat(binary);
  if (
    (await realpath(binary)) !== resolve(binary) ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    !installed ||
    typeof installed !== "object" ||
    !("archive" in installed) ||
    installed.archive !== NGINX_ARCHIVE_SHA256 ||
    !("binary" in installed) ||
    installed.binary !== digest(await readFile(binary))
  )
    throw new Error("NGINX_BINARY_MISMATCH");
  return binary;
}

/** @id CODE-LAN-PROXY @implements REQ-LAN-001 */
export async function installNginx(directory: string, archive?: string) {
  let bytes: Buffer;
  try {
    if (!archive) {
      await privateDirectory(directory);
      await privateFile(join(directory, "package.deb"));
    }
    bytes = await readFile(archive ?? join(directory, "package.deb"));
  } catch (error) {
    if (
      archive ||
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    )
      throw error;
    const response = await fetch(archiveUrl, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw new Error(`NGINX_DOWNLOAD_FAILED_${response.status}`);
    const chunks: Buffer[] = [];
    let size = 0;
    if (!response.body) throw new Error("NGINX_DOWNLOAD_EMPTY");
    const reader = response.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("NGINX_ARCHIVE_TOO_LARGE");
        }
        chunks.push(Buffer.from(chunk.value));
      }
    } finally {
      reader.releaseLock();
    }
    bytes = Buffer.concat(chunks);
  }
  if (digest(bytes) !== NGINX_ARCHIVE_SHA256)
    throw new Error("NGINX_ARCHIVE_HASH");
  const release = await ownership(directory);
  let temporary: string | undefined;
  try {
    const cache = join(directory, "package.deb");
    try {
      await writeFile(cache, bytes, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
      await privateFile(cache);
      if (digest(await readFile(cache)) !== NGINX_ARCHIVE_SHA256)
        throw new Error("NGINX_ARCHIVE_HASH");
    }
    try {
      await lstat(join(directory, "installation/installed.json"));
      await verifiedBinary(directory);
      return;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    temporary = await mkdtemp(join(directory, "install-"));
    await execute("dpkg-deb", ["--extract", cache, temporary], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const binary = join(temporary, "usr/sbin/nginx");
    await execute(binary, ["-v"], { timeout: 10_000 });
    const hash = digest(await readFile(binary));
    await writeFile(
      join(temporary, "installed.json"),
      JSON.stringify({ archive: NGINX_ARCHIVE_SHA256, binary: hash }),
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporary, join(directory, "installation"));
    temporary = undefined;
  } finally {
    if (temporary) await rm(temporary, { recursive: true });
    await release();
  }
}

/** @id CODE-LAN-FORWARD @implements REQ-LAN-003 */
export function nginxConfig(origin: PublicOrigin, port: number): string {
  const parsed = publicOrigin(origin.origin);
  if (
    !parsed ||
    parsed.host !== origin.host ||
    parsed.address !== origin.address ||
    parsed.port !== origin.port
  )
    throw new Error("INVALID_PUBLIC_ORIGIN");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("INVALID_PROXY_UPSTREAM_PORT");
  return `pid nginx.pid;
lock_file nginx.lock;
error_log stderr notice;
worker_processes 1;
worker_shutdown_timeout 5s;
events { worker_connections 128; }
http {
  access_log off;
  server_tokens off;
  client_body_temp_path body;
  proxy_temp_path proxy;
  fastcgi_temp_path fastcgi;
  uwsgi_temp_path uwsgi;
  scgi_temp_path scgi;
  client_max_body_size 100m;
  server {
    listen ${origin.address}:${origin.port};
    server_name ${origin.address};
    if ($http_host != "${origin.host}") { return 403; }
    allow 127.0.0.1;
    allow 10.0.0.0/8;
    allow 172.16.0.0/12;
    allow 192.168.0.0/16;
    deny all;
    location / {
      proxy_pass http://127.0.0.1:${port};
      proxy_http_version 1.1;
      proxy_set_header Host $http_host;
      proxy_set_header Connection "";
      proxy_set_header Forwarded "";
      proxy_set_header X-Forwarded-Host "";
      proxy_set_header X-Forwarded-Proto "";
      proxy_set_header X-Forwarded-For "";
      proxy_set_header X-Forwarded-Port "";
      proxy_set_header X-Forwarded-Server "";
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_cache off;
      proxy_read_timeout 3600s;
    }
  }
}
`;
}

async function upstreamReady(
  origin: PublicOrigin,
  port: number,
  signal?: AbortSignal,
) {
  await new Promise<void>((done, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/projects",
        headers: { Host: origin.host, Origin: origin.origin },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      },
      (response) => {
        response.destroy();
        if (
          response.statusCode !== 200 ||
          !response.headers["content-type"]?.startsWith("application/json")
        )
          reject(new Error("PROXY_UPSTREAM_UNAVAILABLE"));
        else done();
      },
    );
    req.once("error", () =>
      reject(
        signal?.aborted
          ? signal.reason
          : new Error("PROXY_UPSTREAM_UNAVAILABLE"),
      ),
    );
    req.end();
  });
}

/** @id CODE-LAN-START @implements REQ-LAN-001 */
export async function startNginx(
  directory: string,
  origin: PublicOrigin,
  port: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const configuration = nginxConfig(origin, port);
  const binary = await verifiedBinary(directory);
  await upstreamReady(origin, port, signal);
  signal?.throwIfAborted();
  const release = await ownership(directory);
  let child;
  try {
    signal?.throwIfAborted();
    await writePrivate(join(directory, "nginx.conf"), configuration);
    signal?.throwIfAborted();
    child = spawn(
      binary,
      ["-p", directory + "/", "-c", "nginx.conf", "-g", "daemon off;"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    await release();
    throw error;
  }
  let log = "";
  let workerStarted = false;
  let startFailure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((done, reject) => {
    timer = setTimeout(() => reject(new Error("NGINX_START_TIMEOUT")), 15_000);
    child.once("error", reject);
    child.stderr.on("data", (chunk) => {
      log = (log + String(chunk)).slice(-65536);
      if (/start worker process \d+/.test(log)) {
        workerStarted = true;
        done();
      }
    });
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((done) => {
    child.once("error", (error) => {
      startFailure = error;
    });
    child.once("close", (code, signal) => done({ code, signal }));
  }).then(async (result) => {
    try {
      await writePrivate(join(directory, "nginx.log"), log);
    } finally {
      if (!workerStarted || (result.code === 0 && result.signal === null))
        await release();
    }
    if (startFailure || result.code !== 0 || result.signal !== null)
      throw new Error(
        `NGINX_EXIT_FAILED ${startFailure?.message ?? `${result.code}/${result.signal}`}\n${log}`,
      );
  });
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGQUIT");
    await exited;
  };
  const abort = () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGQUIT");
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await Promise.race([
      ready,
      exited.then(() => {
        throw new Error("NGINX_EARLY_EXIT");
      }),
    ]);
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  return { exited, close };
}
