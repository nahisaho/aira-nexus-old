import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import {
  loadCredentials,
  privateDirectory,
  privateFile,
  type Credentials,
} from "./credentials";
import { connectDatabase } from "./database";
import {
  docker,
  inspectOwned,
  type ContainerIdentity,
  type Inspection,
} from "./owned-containers";
import { ServiceError } from "./http";

export const DATABASE_IMAGE =
  "sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac";
const identitySchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    applicationId: z.uuid(),
    controlId: z.uuid(),
    resourceId: z.uuid(),
  })
  .strict();

export async function readDatabaseIdentity(
  state: string,
  credentials: Credentials,
) {
  await privateDirectory(state);
  const path = join(state, "database.json");
  await privateFile(path);
  const identity = identitySchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );
  if (
    identity.applicationId !== credentials.applicationId ||
    identity.controlId !== credentials.controlId
  ) {
    throw new ServiceError(503, "DATABASE_IDENTITY_MISMATCH");
  }
  return identity;
}

async function validateDatabase(identity: ContainerIdentity, state: string) {
  const value = await inspectOwned(identity);
  return validateDatabaseInspection(value, state);
}

export function validateDatabaseInspection(value: Inspection, state: string) {
  const host = value.HostConfig;
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  const mounts = [
    {
      source: join(state, "data"),
      destination: "/var/lib/postgresql/data",
      writable: true,
    },
    {
      source: join(state, "socket"),
      destination: "/var/run/postgresql",
      writable: true,
    },
    {
      source: join(state, "passwd"),
      destination: "/etc/passwd",
      writable: false,
    },
  ];
  if (
    value.Image !== DATABASE_IMAGE ||
    value.Config.Image !== DATABASE_IMAGE ||
    host.Privileged ||
    (host.CapAdd?.length ?? 0) !== 0 ||
    host.Devices.length !== 0 ||
    (host.DeviceRequests?.length ?? 0) !== 0 ||
    host.NetworkMode !== "none" ||
    !host.ReadonlyRootfs ||
    host.Memory !== 384 * 1024 * 1024 ||
    host.NanoCpus !== 500000000 ||
    host.PidsLimit !== 128 ||
    !host.CapDrop.includes("ALL") ||
    !host.SecurityOpt.includes("no-new-privileges") ||
    host.SecurityOpt.length !== 1 ||
    host.CapDrop.length !== 1 ||
    Object.keys(host.PortBindings ?? {}).length !== 0 ||
    value.Config.User !== `${process.getuid?.()}:${process.getgid?.()}` ||
    Object.keys(host.Tmpfs).length !== 1 ||
    host.Tmpfs["/tmp"] !==
      `rw,nosuid,noexec,size=16m,uid=${uid},gid=${gid},mode=0700` ||
    value.Mounts.filter((m) => m.Type === "bind").length !== mounts.length ||
    !mounts.every((expected) =>
      value.Mounts.some(
        (m) =>
          m.Type === "bind" &&
          m.Source === expected.source &&
          m.Destination === expected.destination &&
          m.RW === expected.writable,
      ),
    ) ||
    value.Mounts.some(
      (m) =>
        m.Type !== "bind" && !(m.Type === "tmpfs" && m.Destination === "/tmp"),
    )
  ) {
    throw new ServiceError(503, "DATABASE_ISOLATION_MISMATCH");
  }
  return value;
}

/** @id CODE-OPS-DATABASE @implements REQ-OPS-003 */
export async function startDatabase(state: string, initialize = false) {
  const credentials = await loadCredentials(state, initialize);
  state = await privateDirectory(state);
  if (
    Buffer.byteLength(join(state, "socket", ".s.PGSQL.5432")) > 100 ||
    !process.getuid?.() ||
    !process.getgid?.()
  ) {
    throw new ServiceError(503, "UNSUPPORTED_DATABASE_HOST");
  }
  await privateDirectory(join(state, "data"), initialize);
  await privateDirectory(join(state, "socket"), initialize);
  let identity: ContainerIdentity;
  try {
    identity = await readDatabaseIdentity(state, credentials);
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT") ||
      !initialize
    )
      throw error;
    if ((await readdir(join(state, "data"))).length !== 0) {
      throw new ServiceError(
        503,
        "EXISTING_DATABASE_REQUIRES_EXPLICIT_RECOVERY",
      );
    }
    const uid = process.getuid!(),
      gid = process.getgid!();
    const passwd = join(state, "passwd");
    const env = join(state, "postgres.env");
    await writeFile(
      passwd,
      `root:x:0:0:root:/root:/bin/sh\npostgres:x:${uid}:${gid}:PostgreSQL:/var/lib/postgresql:/bin/sh\n`,
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(env, `POSTGRES_PASSWORD=${credentials.bootstrap}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const resourceId = randomUUID();
    const id = await docker([
      "create",
      "--pull=never",
      "--name",
      `aira-db-${resourceId}`,
      "--label",
      `aira.application=${credentials.applicationId}`,
      "--label",
      `aira.control=${credentials.controlId}`,
      "--label",
      `aira.resource=${resourceId}`,
      "--network=none",
      "--read-only",
      `--user=${uid}:${gid}`,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--cpus=0.5",
      "--memory=384m",
      "--pids-limit=128",
      "--mount",
      `type=bind,src=${join(state, "data")},dst=/var/lib/postgresql/data`,
      "--mount",
      `type=bind,src=${join(state, "socket")},dst=/var/run/postgresql`,
      "--mount",
      `type=bind,src=${passwd},dst=/etc/passwd,readonly`,
      "--tmpfs",
      `/tmp:rw,nosuid,noexec,size=16m,uid=${uid},gid=${gid},mode=0700`,
      "--env",
      "POSTGRES_USER=aira_bootstrap",
      "--env",
      "POSTGRES_DB=aira",
      "--env-file",
      env,
      "--env",
      "POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256",
      DATABASE_IMAGE,
      "postgres",
      "-c",
      "listen_addresses=",
      "-c",
      "unix_socket_directories=/var/run/postgresql",
      "-c",
      "unix_socket_permissions=0700",
      "-c",
      "password_encryption=scram-sha-256",
    ]);
    identity = {
      id,
      applicationId: credentials.applicationId,
      controlId: credentials.controlId,
      resourceId,
    };
    const handle = await open(join(state, "database.json"), "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(identity));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await privateFile(join(state, "passwd"));
  await privateFile(join(state, "postgres.env"));
  if (!(await validateDatabase(identity, state)).State.Running)
    await docker(["start", identity.id]);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (
      (await docker(["exec", identity.id, "readlink", "/proc/1/exe"])).endsWith(
        "/postgres",
      )
    ) {
      const socketInfo = await lstat(join(state, "socket"));
      if (
        !socketInfo.isDirectory() ||
        socketInfo.isSymbolicLink() ||
        socketInfo.uid !== process.getuid?.()
      ) {
        throw new ServiceError(503, "UNSAFE_DATABASE_SOCKET");
      }
      await chmod(join(state, "socket"), 0o700);
      try {
        const client = await connectDatabase(state, credentials, "bootstrap");
        try {
          const version = (await client.query("SHOW server_version")).rows[0]
            .server_version as string;
          if (!version.startsWith("17.11"))
            throw new ServiceError(503, "DATABASE_VERSION_MISMATCH");
          if (
            (await client.query("SHOW listen_addresses")).rows[0]
              .listen_addresses !== ""
          ) {
            throw new ServiceError(503, "DATABASE_TCP_NOT_DISABLED");
          }
          return { credentials, identity, version };
        } finally {
          await client.end();
        }
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ECONNREFUSED", "ECONNRESET", "57P03"].includes(
            String(error.code),
          )
        ))
          throw error;
      }
    }
    await wait(50);
  }
  throw new ServiceError(503, "DATABASE_START_TIMEOUT");
}
