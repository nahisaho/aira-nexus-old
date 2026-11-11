import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ServiceError } from "./http";

const credentialsSchema = z
  .object({
    version: z.literal(1),
    applicationId: z.uuid(),
    controlId: z.uuid(),
    bootstrap: z.string().regex(/^[a-f0-9]{64}$/),
    migration: z.string().regex(/^[a-f0-9]{64}$/),
    application: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type Credentials = z.infer<typeof credentialsSchema>;

export async function privateDirectory(path: string, create = false) {
  const absolute = resolve(path);
  if ((await realpath(dirname(absolute))) !== dirname(absolute)) {
    throw new ServiceError(503, "UNSAFE_STATE_PARENT");
  }
  if (create) {
    try {
      await mkdir(absolute, { mode: 0o700 });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
  }
  const info = await lstat(absolute);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw new ServiceError(503, "UNSAFE_STATE_DIRECTORY");
  }
  return absolute;
}

export async function privateFile(path: string) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600 ||
    info.nlink !== 1
  ) {
    throw new ServiceError(503, "UNSAFE_STATE_FILE");
  }
}

/** @id CODE-OPS-CREDENTIALS @implements REQ-OPS-003 */
export async function loadCredentials(
  state: string,
  initialize = false,
): Promise<Credentials> {
  await privateDirectory(state, initialize);
  const path = join(state, "credentials.json");
  if (initialize) {
    const credentials: Credentials = {
      version: 1,
      applicationId: randomUUID(),
      controlId: randomUUID(),
      bootstrap: randomBytes(32).toString("hex"),
      migration: randomBytes(32).toString("hex"),
      application: randomBytes(32).toString("hex"),
    };
    try {
      const handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(JSON.stringify(credentials));
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ))
        throw error;
    }
  }
  await privateFile(path);
  return credentialsSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
