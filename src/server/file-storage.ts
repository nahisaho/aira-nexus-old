import { constants } from "node:fs";
import { open, rename, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { privateDirectory } from "./credentials";
import { ServiceError } from "./http";

/** @id CODE-DATA-STORAGE @implements REQ-DATA-001 REQ-DATA-002 */
export class FileStorage {
  constructor(readonly root: string) {}
  async initialize() {
    await privateDirectory(this.root, true);
    for (const leaf of ["pending", "blobs"])
      await privateDirectory(join(this.root, leaf), true);
  }
  path(id: string, pending = false) {
    if (!z.uuid().safeParse(id).success)
      throw new ServiceError(400, "INVALID_BLOB_ID");
    return join(this.root, pending ? "pending" : "blobs", id);
  }
  async create(id: string = randomUUID()) {
    const handle = await open(
      this.path(id, true),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    return { id, handle };
  }
  async publish(id: string) {
    await rename(this.path(id, true), this.path(id));
    const directory = await open(
      join(this.root, "blobs"),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  async remove(id: string, pending = false) {
    try {
      await unlink(this.path(id, pending));
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  async open(id: string) {
    const handle = await open(
      this.path(id),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600
      )
        throw new ServiceError(503, "UNSAFE_BLOB_FILE");
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async *read(id: string) {
    const handle = await this.open(id);
    try {
      for (;;) {
        const buffer = Buffer.allocUnsafe(512 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        yield buffer.subarray(0, bytesRead);
      }
    } finally {
      await handle.close();
    }
  }
  async verify(id: string, size: number, expected: string) {
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of this.read(id)) {
      bytes += chunk.length;
      digest.update(chunk);
    }
    if (bytes !== size || digest.digest("hex") !== expected)
      throw new ServiceError(503, "FILE_INTEGRITY_ERROR");
  }
}

export async function storageDirectory(state: string) {
  await privateDirectory(state);
  const root = join(state, "files");
  await mkdir(root, { mode: 0o700, recursive: true });
  await privateDirectory(root);
  return root;
}
