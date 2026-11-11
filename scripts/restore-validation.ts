import type { Credentials } from "../src/server/credentials";
import type { ContainerIdentity } from "../src/server/owned-containers";
import { stopOwned } from "../src/server/owned-containers";
import { privateDirectory, privateFile } from "../src/server/credentials";
import { startDatabase } from "../src/server/db-container";
import { connectDatabase } from "../src/server/database";
import { FileStorage } from "../src/server/file-storage";
import { ServiceError } from "../src/server/http";
import {
  backupManifestSchema,
  databaseTool,
  exclusiveDirectory,
  fileDigest,
  overlaps,
  schemaFingerprint,
} from "./backup";
import { migrate } from "./migrate";
import { validateProjectLabNotes } from "../src/server/notebooks";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
export interface RestoredValidation {
  state: string;
  credentials: Credentials;
  identity: ContainerIdentity;
}
/** @id CODE-DIAG-RESTORE @implements REQ-DIAG-002 REQ-NH-006 */
export async function restoreValidation(
  archive: string,
  destination: string,
): Promise<RestoredValidation> {
  archive = resolve(archive);
  destination = resolve(destination);
  try {
    await lstat(destination);
    throw new ServiceError(409, "DESTINATION_MUST_BE_NEW");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (overlaps(archive, destination))
    throw new ServiceError(409, "RESTORE_ARCHIVE_OVERLAP");
  await privateDirectory(archive);
  await privateFile(join(archive, "manifest.json"));
  const manifestInfo = await lstat(join(archive, "manifest.json"));
  if (manifestInfo.size > 32 * 1024 * 1024)
    throw new ServiceError(413, "BACKUP_MANIFEST_TOO_LARGE");
  const parsed = backupManifestSchema.safeParse(
    JSON.parse(await readFile(join(archive, "manifest.json"), "utf8")),
  );
  if (!parsed.success) throw new ServiceError(400, "INVALID_BACKUP_MANIFEST");
  const manifest = parsed.data;
  if (
    new Set(manifest.blobs.map((blob) => blob.id)).size !==
    manifest.blobs.length
  )
    throw new ServiceError(400, "DUPLICATE_BACKUP_BLOB");
  if ((await schemaFingerprint()).sha256 !== manifest.schemaSha256)
    throw new ServiceError(409, "UNSUPPORTED_BACKUP_SCHEMA");
  await privateFile(join(archive, "research.dump"));
  if (
    (await fileDigest(join(archive, "research.dump"))) !== manifest.dumpSha256
  )
    throw new ServiceError(503, "BACKUP_DUMP_INTEGRITY_ERROR");
  await privateDirectory(join(archive, "blobs"));
  if ((await readdir(join(archive, "blobs"))).length !== manifest.blobs.length)
    throw new ServiceError(503, "BACKUP_BLOB_SCOPE_MISMATCH");
  for (const blob of manifest.blobs) {
    const path = join(archive, "blobs", blob.id);
    await privateFile(path);
    if (
      (await lstat(path)).size !== blob.size ||
      (await fileDigest(path)) !== blob.sha256
    )
      throw new ServiceError(503, "BACKUP_BLOB_INTEGRITY_ERROR");
  }
  await exclusiveDirectory(destination);
  let database: Awaited<ReturnType<typeof startDatabase>> | undefined;
  try {
    database = await startDatabase(destination, true);
    const { credentials, identity } = database;
    if (
      credentials.applicationId === manifest.source.applicationId ||
      credentials.controlId === manifest.source.controlId
    )
      throw new ServiceError(503, "RESTORE_IDENTITY_NOT_INDEPENDENT");
    await migrate(destination, credentials);
    const copied = join(destination, "data", "aira-validation.dump");
    await copyFile(
      join(archive, "research.dump"),
      copied,
      constants.COPYFILE_EXCL,
    );
    const triggerControl = await connectDatabase(
      destination,
      credentials,
      "bootstrap",
    );
    try {
      await triggerControl.query(
        "ALTER TABLE chats DISABLE TRIGGER project_lab_note_created",
      );
      await databaseTool(identity, credentials, "pg_restore", [
        "-U",
        "aira_bootstrap",
        "-h",
        "/var/run/postgresql",
        "-d",
        "aira",
        "--data-only",
        "--no-owner",
        "--no-acl",
        "--single-transaction",
        "--exit-on-error",
        "/var/lib/postgresql/data/aira-validation.dump",
      ]);
    } finally {
      try {
        await triggerControl.query(
          "ALTER TABLE chats ENABLE TRIGGER project_lab_note_created",
        );
      } finally {
        await triggerControl.end();
        await unlink(copied);
      }
    }
    const storage = new FileStorage(join(destination, "files"));
    await storage.initialize();
    for (const blob of manifest.blobs) {
      const created = await storage.create(blob.id);
      try {
        const input = await open(join(archive, "blobs", blob.id), "r");
        try {
          for await (const chunk of input.createReadStream({
            autoClose: false,
          }))
            await created.handle.writeFile(chunk);
        } finally {
          await input.close();
        }
        await created.handle.sync();
      } finally {
        await created.handle.close();
      }
      await storage.publish(blob.id);
      await storage.verify(blob.id, blob.size, blob.sha256);
    }
    const client = await connectDatabase(destination, credentials, "bootstrap");
    try {
      await client.query("BEGIN");
      const blobs = (
        await client.query<{ id: string; size: number; sha256: string }>(
          "SELECT blob_id AS id,size::integer AS size,sha256 FROM file_versions ORDER BY blob_id",
        )
      ).rows;
      const expected = [...manifest.blobs].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      if (JSON.stringify(blobs) !== JSON.stringify(expected))
        throw new ServiceError(503, "RESTORED_BLOB_SCOPE_MISMATCH");
      const invalid =
        await client.query(`SELECT p.id FROM projects p LEFT JOIN chats c
        ON c.id=p.chat_id AND c.project_id=p.id AND c.actor=p.actor
        WHERE c.id IS NULL OR (SELECT count(*) FROM chats WHERE project_id=p.id)<>1`);
      if (invalid.rowCount)
        throw new ServiceError(503, "RESTORED_CHAT_LINK_INVALID");
      await validateProjectLabNotes(client);
      const corruptVersions = await client.query(`
        SELECT id FROM notebook_versions
        WHERE sha256<>encode(sha256(convert_to(content::text,'UTF8')),'hex') LIMIT 1
      `);
      if (corruptVersions.rowCount)
        throw new ServiceError(503, "RESTORED_NOTEBOOK_VERSION_HASH_INVALID");
      const invalidHeads = await client.query(`
        SELECT n.id FROM notebooks n JOIN notebook_links l USING(id)
        LEFT JOIN notebook_versions v ON v.notebook_id=n.id AND v.project_id=l.project_id
          AND v.actor=l.actor AND v.revision=n.revision
          AND v.content=jsonb_build_object('name',n.name,'document',notebook_source_document(n.document))
        GROUP BY n.id HAVING count(v.id)<>1 LIMIT 1
      `);
      if (invalidHeads.rowCount)
        throw new ServiceError(503, "RESTORED_NOTEBOOK_HEAD_INVALID");
      await client.query("DELETE FROM notebook_git_receipts");
      await client.query(`
        UPDATE notebook_git_exports SET generation_id=NULL,state='pending',attempts=0,error_code=NULL,
          commit=NULL,expected_parent=NULL,prepared_parent=NULL,prepared_tree=NULL,prepared_commit=NULL,next_attempt_ms=0
      `);
      await client.query(
        "UPDATE notebook_git_generations SET parent_generation=NULL",
      );
      await client.query("DELETE FROM notebook_git_generations");
      await client.query("UPDATE notebook_git_projects SET rebuilt=true");
      await client.query(
        "UPDATE jobs SET state='interrupted',cleanup='unknown' WHERE state IN ('queued','running')",
      );
      await client.query(
        "UPDATE grants SET expires_at=LEAST(expires_at,clock_timestamp())",
      );
      await client.query("UPDATE confirmations SET revoked=true");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
    const audit = await open(
      join(destination, "restore-audit.json"),
      "wx",
      0o600,
    );
    try {
      await audit.writeFile(
        JSON.stringify({
          version: 1,
          restoredAt: new Date().toISOString(),
          source: manifest.source,
          dumpSha256: manifest.dumpSha256,
          inert: manifest.inert,
          authority:
            "NONE; historical records are not live container or writer authority",
        }),
      );
      await audit.sync();
    } finally {
      await audit.close();
    }
    return { state: destination, credentials, identity };
  } catch (error) {
    if (database) {
      try {
        await stopOwned(database.identity);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "RESTORE_FAILED_CLEANUP_UNCERTAIN",
        );
      }
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 4) {
    console.error(
      "USAGE: restore-validation.ts BACKUP_DIRECTORY NEW_VALIDATION_STATE",
    );
    process.exitCode = 1;
  } else {
    try {
      await restoreValidation(process.argv[2], process.argv[3]);
      console.log("VALIDATION_RESTORE_COMPLETE");
    } catch (error) {
      console.error(
        error instanceof ServiceError
          ? error.code
          : "VALIDATION_RESTORE_FAILED",
      );
      process.exitCode = 1;
    }
  }
}
