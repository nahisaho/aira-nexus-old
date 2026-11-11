import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  loadCredentials,
  privateDirectory,
  type Credentials,
} from "../src/server/credentials";
import {
  readDatabaseIdentity,
  validateDatabaseInspection,
} from "../src/server/db-container";
import {
  inspectOwned,
  type ContainerIdentity,
} from "../src/server/owned-containers";
import { connectDatabase } from "../src/server/database";
import { FileStorage } from "../src/server/file-storage";
import { validateProjectLabNotes } from "../src/server/notebooks";
import { ServiceError } from "../src/server/http";

export const INERT_TABLES = [
  "writer_control",
  "operation_containers",
  "runtime_containers",
  "runtime_job_bindings",
  "runtime_reservations",
  "file_reservations",
] as const;
export const backupManifestSchema = z
  .object({
    version: z.literal(1),
    schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    dumpSha256: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.object({ applicationId: z.uuid(), controlId: z.uuid() }).strict(),
    blobs: z
      .array(
        z
          .object({
            id: z.uuid(),
            size: z.number().int().min(0).max(104857600),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(100000),
    inert: z.record(z.string(), z.array(z.unknown())),
  })
  .strict();
export interface BackupManifest {
  version: 1;
  schemaSha256: string;
  dumpSha256: string;
  source: { applicationId: string; controlId: string };
  blobs: { id: string; size: number; sha256: string }[];
  inert: Record<string, unknown[]>;
}
export function overlaps(a: string, b: string) {
  const inside = (parent: string, child: string) => {
    const path = relative(parent, child);
    return (
      !path ||
      (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path))
    );
  };
  return inside(a, b) || inside(b, a);
}
export async function schemaFingerprint() {
  const directory = join(process.cwd(), "src/server/migrations");
  const names = (await readdir(directory))
    .filter((name) => /^\d{3}-[a-z-]+\.sql$/.test(name))
    .sort();
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name + "\0");
    hash.update(await readFile(join(directory, name)));
  }
  return {
    sha256: hash.digest("hex"),
    names: names.map((name) => name.slice(0, -4)),
  };
}
export async function fileDigest(path: string) {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
export async function exclusiveDirectory(path: string) {
  if ((await realpath(dirname(path))) !== dirname(path))
    throw new ServiceError(503, "UNSAFE_DESTINATION_PARENT");
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new ServiceError(409, "DESTINATION_MUST_BE_NEW");
    throw error;
  }
  return privateDirectory(path);
}
export async function databaseTool(
  identity: ContainerIdentity,
  credentials: Credentials,
  tool: "pg_dump" | "pg_restore",
  args: string[],
  output?: string,
) {
  await inspectOwned(identity);
  const handle = output ? await open(output, "wx", 0o600) : undefined;
  try {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        identity.id,
        "sh",
        "-c",
        tool === "pg_dump"
          ? 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec pg_dump "$@"'
          : 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec pg_restore "$@"',
        "aira-database-tool",
        ...args,
      ],
      { stdio: ["pipe", handle?.fd ?? "ignore", "ignore"], timeout: 120000 },
    );
    const input = child.stdin;
    if (!input) {
      child.kill("SIGTERM");
      throw new ServiceError(503, "DATABASE_ARCHIVE_INPUT_UNAVAILABLE");
    }
    await new Promise<void>((done, reject) => {
      let failed = false;
      child.once("error", () => {
        failed = true;
      });
      input.on("error", () => {
        failed = true;
        child.kill("SIGTERM");
      });
      child.once("close", (code) => {
        if (failed || code !== 0)
          reject(new ServiceError(503, "DATABASE_ARCHIVE_COMMAND_FAILED"));
        else done();
      });
      input.end(credentials.bootstrap + "\n");
    });
    await handle?.sync();
  } finally {
    await handle?.close();
  }
}
/** @id CODE-DIAG-BACKUP @implements REQ-DIAG-002 */
export async function backup(
  state: string,
  destination: string,
): Promise<BackupManifest> {
  state = resolve(state);
  destination = resolve(destination);
  if (overlaps(state, destination))
    throw new ServiceError(409, "BACKUP_SOURCE_OVERLAP");
  await privateDirectory(state);
  const credentials = await loadCredentials(state);
  const identity = await readDatabaseIdentity(state, credentials);
  validateDatabaseInspection(await inspectOwned(identity), state);
  const client = await connectDatabase(state, credentials, "bootstrap");
  let locked = false,
    began = false;
  try {
    locked =
      (await client.query("SELECT pg_try_advisory_lock(918273645) AS held"))
        .rows[0].held === true;
    if (!locked)
      throw new ServiceError(409, "BACKUP_REQUIRES_QUIESCENT_WRITER");
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    began = true;
    const schema = await schemaFingerprint();
    const applied = (
      await client.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      )
    ).rows.map((row) => row.name);
    if (JSON.stringify(applied) !== JSON.stringify(schema.names))
      throw new ServiceError(409, "UNSUPPORTED_BACKUP_SCHEMA");
    await validateProjectLabNotes(client);
    const snapshot = (
      await client.query("SELECT pg_export_snapshot() AS snapshot")
    ).rows[0].snapshot as string;
    const blobs = (
      await client.query<{ id: string; size: number; sha256: string }>(
        "SELECT blob_id AS id,size::integer AS size,sha256 FROM file_versions ORDER BY blob_id",
      )
    ).rows;
    const inert: BackupManifest["inert"] = {};
    for (const table of INERT_TABLES)
      inert[table] = (await client.query(`SELECT * FROM ${table}`)).rows;
    await exclusiveDirectory(destination);
    await privateDirectory(join(destination, "blobs"), true);
    const storage = new FileStorage(join(state, "files"));
    if (blobs.length) {
      await privateDirectory(storage.root);
      await privateDirectory(join(storage.root, "blobs"));
    }
    for (const blob of blobs) {
      await storage.verify(blob.id, blob.size, blob.sha256);
      const file = await open(join(destination, "blobs", blob.id), "wx", 0o600);
      try {
        for await (const chunk of storage.read(blob.id))
          await file.writeFile(chunk);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await databaseTool(
      identity,
      credentials,
      "pg_dump",
      [
        "-U",
        "aira_bootstrap",
        "-h",
        "/var/run/postgresql",
        "-d",
        "aira",
        "--format=custom",
        "--data-only",
        "--no-owner",
        "--no-acl",
        "--lock-wait-timeout=10000",
        `--snapshot=${snapshot}`,
        ...[...INERT_TABLES, "schema_migrations"].map(
          (table) => `--exclude-table-data=public.${table}`,
        ),
      ],
      join(destination, "research.dump"),
    );
    const manifest: BackupManifest = {
      version: 1,
      schemaSha256: schema.sha256,
      dumpSha256: await fileDigest(join(destination, "research.dump")),
      source: {
        applicationId: credentials.applicationId,
        controlId: credentials.controlId,
      },
      blobs,
      inert,
    };
    const file = await open(join(destination, "manifest.json"), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(manifest));
      await file.sync();
    } finally {
      await file.close();
    }
    await client.query("COMMIT");
    began = false;
    return manifest;
  } finally {
    try {
      if (began) await client.query("ROLLBACK");
      if (locked) await client.query("SELECT pg_advisory_unlock(918273645)");
    } finally {
      await client.end();
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 4) {
    console.error("USAGE: backup.ts SOURCE_STATE NEW_BACKUP_DIRECTORY");
    process.exitCode = 1;
  } else {
    try {
      await backup(process.argv[2], process.argv[3]);
      console.log("BACKUP_COMPLETE");
    } catch (error) {
      console.error(
        error instanceof ServiceError ? error.code : "BACKUP_FAILED",
      );
      process.exitCode = 1;
    }
  }
}
