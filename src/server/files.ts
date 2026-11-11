import pg from "pg";
import { databaseConfig } from "./database";
import type { Credentials } from "./credentials";
import { Operations } from "./operations";
import { FileStorage } from "./file-storage";
import { ServiceError } from "./http";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { ownedProject, projectId as validId } from "./project-scope";
import { validText } from "./chat-context";
import { privateDirectory } from "./credentials";

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_INPUT_BYTES = 256 * 1024 * 1024;
export const FILE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;
const FILE_COLUMNS = `id, project_id AS "projectId", actor, name, mime,
  size::integer AS size, sha256, blob_id AS "blobId"`;
export function safeFileName(value: string) {
  const name = validText(value, 240);
  if (
    name !== name.normalize("NFC") ||
    Buffer.byteLength(name) > 240 ||
    /[\u0000-\u001f\u007f/\\:]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    name === "."
  )
    throw new ServiceError(400, "UNSAFE_FILE_NAME");
  return name;
}
function active(status: string) {
  if (status !== "active") throw new ServiceError(409, "PROJECT_ARCHIVED");
}

export interface FileVersion {
  id: string;
  projectId: string;
  actor: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  blobId: string;
}
export interface FileSelection {
  id: string;
  name: string;
}
export type FileOrigin =
  | { kind: "upload" }
  | { kind: "run"; notebookId: string; runId: string }
  | { kind: "turn"; turnId: string };
/** @id CODE-DATA-FILES @implements REQ-DATA-001 REQ-DATA-002 REQ-DATA-003 */
export class Files {
  private readonly pool: pg.Pool;
  private readonly prepared = new WeakSet<object>();
  constructor(
    private readonly operations: Operations,
    readonly storage: FileStorage,
    state: string,
    credentials: Credentials,
  ) {
    this.pool = new pg.Pool({
      ...databaseConfig(state, credentials, "application"),
      max: 4,
    });
    this.pool.on("error", () => console.error("FILE_DATABASE_CONNECTION_LOST"));
  }
  async upload(
    actor: string,
    projectId: string,
    name: string,
    mime: string,
    body: AsyncIterable<Uint8Array>,
  ): Promise<FileVersion> {
    const file = await this.prepare(actor, projectId, name, mime, body);
    try {
      return await this.operations.write((client) =>
        this.commitPrepared(client, file),
      );
    } catch (error) {
      try {
        await this.discardPrepared(file);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "FILE_PUBLICATION_CLEANUP_UNCERTAIN",
        );
      }
      throw error;
    }
  }
  /** @id CODE-PROV-PREPARED @implements REQ-PROV-002 */
  async prepare(
    actor: string,
    projectId: string,
    name: string,
    mime: string,
    body: AsyncIterable<Uint8Array>,
  ): Promise<FileVersion> {
    name = safeFileName(name);
    if (
      !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime) ||
      mime.length > 120
    )
      throw new ServiceError(400, "INVALID_FILE_MIME");
    const reservation = await this.reserve(actor, projectId);
    let handle:
      Awaited<ReturnType<FileStorage["create"]>>["handle"] | undefined;
    try {
      handle = (await this.storage.create(reservation)).handle;
      const digest = createHash("sha256");
      let size = 0;
      for await (const input of body) {
        if (!(input instanceof Uint8Array))
          throw new ServiceError(400, "INVALID_FILE_CHUNK");
        for (let offset = 0; offset < input.byteLength; offset += 512 * 1024) {
          const chunk = input.subarray(offset, offset + 512 * 1024);
          await this.grow(actor, projectId, reservation, chunk.byteLength);
          await handle.writeFile(chunk);
          digest.update(chunk);
          size += chunk.byteLength;
        }
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.storage.publish(reservation);
      const sha256 = digest.digest("hex"),
        id = randomUUID();
      const file = Object.freeze({
        id,
        projectId,
        actor,
        name,
        mime: mime.toLowerCase(),
        size,
        sha256,
        blobId: reservation,
      });
      this.prepared.add(file);
      return file;
    } catch (error) {
      const cleanup = await Promise.allSettled([
        ...(handle ? [handle.close()] : []),
        this.storage.remove(reservation, true),
        this.storage.remove(reservation),
        this.release(actor, reservation),
      ]);
      const failures = cleanup
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          "FILE_UPLOAD_CLEANUP_FAILED",
        );
      throw error;
    }
  }
  assertPrepared(file: FileVersion) {
    if (!this.isPrepared(file))
      throw new ServiceError(400, "UNRECOGNIZED_PREPARED_FILE");
  }
  isPrepared(file: unknown): file is FileVersion {
    return typeof file === "object" && file !== null && this.prepared.has(file);
  }
  async commitPrepared(
    client: pg.Client,
    file: FileVersion,
    origin: FileOrigin = { kind: "upload" },
  ): Promise<FileVersion> {
    this.operations.assertTransaction(client);
    this.assertPrepared(file);
    const project = await ownedProject(
      client,
      file.actor,
      file.projectId,
      true,
    );
    active(project.status);
    await this.storage.verify(file.blobId, file.size, file.sha256);
    const reserved = await client.query(
      "SELECT bytes::integer AS bytes FROM file_reservations WHERE id=$1 AND actor=$2 AND project_id=$3 AND epoch=(SELECT epoch FROM writer_control)",
      [file.blobId, file.actor, file.projectId],
    );
    if (reserved.rowCount !== 1 || reserved.rows[0].bytes !== file.size)
      throw new ServiceError(409, "FILE_RESERVATION_LOST");
    const result = await client.query<FileVersion>(
      `INSERT INTO file_versions(id,project_id,actor,name,mime,size,sha256,blob_id,origin_kind,chat_id,notebook_id,run_id,turn_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${FILE_COLUMNS}`,
      [
        file.id,
        file.projectId,
        file.actor,
        file.name,
        file.mime,
        file.size,
        file.sha256,
        file.blobId,
        origin.kind,
        project.chatId,
        origin.kind === "run" ? origin.notebookId : null,
        origin.kind === "run" ? origin.runId : null,
        origin.kind === "turn" ? origin.turnId : null,
      ],
    );
    await client.query(
      "DELETE FROM file_reservations WHERE id=$1 AND actor=$2",
      [file.blobId, file.actor],
    );
    return result.rows[0];
  }
  async discardPrepared(file: FileVersion): Promise<void> {
    this.assertPrepared(file);
    // The writer fence resolves prior commits before any possibly visible bytes are deleted.
    await this.operations.write(async (client) => {
      const visible = await client.query(
        "SELECT id FROM file_versions WHERE blob_id=$1",
        [file.blobId],
      );
      if (visible.rowCount) return;
      await this.storage.remove(file.blobId, true);
      await this.storage.remove(file.blobId);
      await client.query(
        "DELETE FROM file_reservations WHERE id=$1 AND actor=$2",
        [file.blobId, file.actor],
      );
    });
    this.prepared.delete(file);
  }
  async get(
    actor: string,
    projectId: string,
    id: string,
  ): Promise<FileVersion> {
    validId(id);
    await ownedProject(this.pool, actor, projectId);
    const result = await this.pool.query<FileVersion>(
      `SELECT ${FILE_COLUMNS} FROM file_versions WHERE id=$1 AND project_id=$2 AND actor=$3`,
      [id, projectId, actor],
    );
    if (result.rowCount !== 1) throw new ServiceError(404, "FILE_NOT_FOUND");
    return result.rows[0];
  }
  async list(actor: string, projectId: string): Promise<FileVersion[]> {
    await ownedProject(this.pool, actor, projectId);
    return (
      await this.pool.query<FileVersion>(
        `SELECT ${FILE_COLUMNS} FROM file_versions WHERE project_id=$1 AND actor=$2 ORDER BY created_at,id`,
        [projectId, actor],
      )
    ).rows;
  }
  async reserve(actor: string, projectId: string): Promise<string> {
    return this.operations.write(async (client) => {
      active((await ownedProject(client, actor, projectId, true)).status);
      const abandoned = await client.query<{ id: string }>(
        "DELETE FROM file_reservations WHERE epoch<>(SELECT epoch FROM writer_control) RETURNING id",
      );
      for (const old of abandoned.rows) {
        await this.storage.remove(old.id, true);
        await this.storage.remove(old.id);
      }
      const id = randomUUID();
      await client.query(
        "INSERT INTO file_reservations(id,project_id,actor,epoch) SELECT $1,$2,$3,epoch FROM writer_control",
        [id, projectId, actor],
      );
      return id;
    });
  }
  async grow(
    actor: string,
    projectId: string,
    id: string,
    bytes: number,
  ): Promise<void> {
    validId(id);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_FILE_BYTES)
      throw new ServiceError(413, "FILE_TOO_LARGE");
    await this.operations.write(async (client) => {
      active((await ownedProject(client, actor, projectId, true)).status);
      const reservation = await client.query(
        "SELECT bytes::integer AS bytes FROM file_reservations WHERE id=$1 AND actor=$2 AND project_id=$3 AND epoch=(SELECT epoch FROM writer_control) FOR UPDATE",
        [id, actor, projectId],
      );
      if (reservation.rowCount !== 1)
        throw new ServiceError(409, "FILE_RESERVATION_LOST");
      if (reservation.rows[0].bytes + bytes > MAX_FILE_BYTES)
        throw new ServiceError(413, "FILE_TOO_LARGE");
      const used = await client.query(
        `SELECT (
        coalesce((SELECT sum(size) FROM file_versions WHERE project_id=$1 AND actor=$2),0)+
        coalesce((SELECT sum(bytes) FROM file_reservations WHERE project_id=$1 AND actor=$2),0)
        )::text AS bytes`,
        [projectId, actor],
      );
      if (Number(used.rows[0].bytes) + bytes > FILE_QUOTA_BYTES)
        throw new ServiceError(413, "FILE_QUOTA_EXCEEDED");
      await client.query(
        "UPDATE file_reservations SET bytes=bytes+$1 WHERE id=$2",
        [bytes, id],
      );
    });
  }
  async release(actor: string, id: string): Promise<void> {
    await this.operations.write(async (client) => {
      await client.query(
        "DELETE FROM file_reservations WHERE id=$1 AND actor=$2",
        [id, actor],
      );
    });
  }
  async select(
    actor: string,
    projectId: string,
    selections: FileSelection[],
  ): Promise<(FileVersion & { workspaceName: string })[]> {
    const parsed = z
      .array(z.object({ id: z.uuid(), name: z.string() }).strict())
      .safeParse(selections);
    if (!parsed.success) throw new ServiceError(400, "INVALID_FILE_SELECTION");
    const names = new Set<string>(),
      result = [];
    active((await ownedProject(this.pool, actor, projectId)).status);
    let total = 0;
    for (const selection of parsed.data) {
      const name = safeFileName(selection.name);
      if (names.has(name))
        throw new ServiceError(409, "WORKSPACE_NAME_COLLISION");
      names.add(name);
      const version = await this.get(actor, projectId, selection.id);
      total += version.size;
      if (total > MAX_INPUT_BYTES)
        throw new ServiceError(413, "INPUT_BUDGET_EXCEEDED");
      result.push({ ...version, workspaceName: name });
    }
    for (const version of result)
      await this.storage.verify(version.blobId, version.size, version.sha256);
    return result;
  }
  async stage(
    actor: string,
    projectId: string,
    selections: FileSelection[],
    directory: string,
  ): Promise<void> {
    const selected = await this.select(actor, projectId, selections);
    await privateDirectory(directory);
    const created: string[] = [];
    try {
      for (const version of selected) {
        const path = join(directory, version.workspaceName);
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
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
            throw new ServiceError(409, "WORKSPACE_NAME_COLLISION");
          throw error;
        }
        created.push(path);
        try {
          const hash = createHash("sha256");
          let size = 0;
          for await (const chunk of this.storage.read(version.blobId)) {
            size += chunk.length;
            if (size > version.size)
              throw new ServiceError(503, "FILE_INTEGRITY_ERROR");
            hash.update(chunk);
            await handle.writeFile(chunk);
          }
          if (size !== version.size || hash.digest("hex") !== version.sha256)
            throw new ServiceError(503, "FILE_INTEGRITY_ERROR");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      const cleanup = await Promise.allSettled(
        created.map((path) => unlink(path)),
      );
      const failures = cleanup
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          "STAGING_CLEANUP_FAILED",
        );
      throw error;
    }
  }
  async close() {
    await this.pool.end();
  }
}
