import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflate } from "node:zlib";

export interface GitHistoryEvent {
  id: string;
  projectId: string;
  notebookId: string;
  revision: number;
  canonicalContent: string;
  sha256: string;
  recordedAt: string;
  origin: string;
  editor: string | null;
  reason: string | null;
  proposalId: string | null;
  restoredFrom: number | null;
}

export interface GitHistoryContext {
  generationId: string;
  applicationId: string;
  projectId: string;
}

export interface GitPrepared {
  parent: string | null;
  tree: string;
  commit: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT = /^[0-9a-f]{40}$/;
const MAX_STDIN = 512 * 1024 * 1024;
const MAX_STDOUT = 2 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;
const MARKER = ".aira-history.json";
const LOCK = ".aira-history.lock";
const REF = "refs/heads/main";
const ZERO = "0".repeat(40);
const CONFIG =
  /^\[core\]\n\s*repositoryformatversion = 0\n\s*filemode = (true|false)\n\s*bare = true\n$/;
const IDENTITY = "AIRA Nexus <notebook-history@aira.local>";

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function ownedDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.()
  ) {
    throw new Error("Unsafe Git object/ref directory");
  }
}

async function emptyDirectory(path: string) {
  await ownedDirectory(path);
  if ((await readdir(path)).length !== 0) {
    throw new Error(
      "Unverifiable Git repository: expected empty metadata directory",
    );
  }
}

async function recoverableInitialisation(repository: string) {
  const names = await readdir(repository);
  const allowed = new Set([MARKER, LOCK, "HEAD", "config", "objects", "refs"]);
  if (names.some((name) => !allowed.has(name))) {
    throw new Error(
      "Unsafe partial Git initialisation: unknown repository entries",
    );
  }
  for (const [name, expected] of [
    ["HEAD", `ref: ${REF}\n`],
    ["config", null],
  ] as const) {
    if (!names.includes(name)) continue;
    const text = (
      await smallFile(join(/* turbopackIgnore: true */ repository, name))
    ).text;
    if (expected !== null ? text !== expected : !CONFIG.test(text)) {
      throw new Error("Unsafe partial Git initialisation: corrupt HEAD/config");
    }
  }
  // No object of any kind (including dangling objects), ref, pack, reflog or
  // unknown entry may exist. Re-init can only complete an empty owned skeleton.
  for (const [name, children] of [
    ["objects", ["info", "pack"]],
    ["refs", ["heads", "tags"]],
  ] as const) {
    const path = join(/* turbopackIgnore: true */ repository, name);
    if (!names.includes(name)) continue;
    await ownedDirectory(path);
    for (const child of await readdir(/* turbopackIgnore: true */ path)) {
      if (!(children as readonly string[]).includes(child)) {
        throw new Error(
          "Unsafe partial Git initialisation: object/history entries exist",
        );
      }
      await emptyDirectory(join(/* turbopackIgnore: true */ path, child));
    }
  }
}

interface IntendedObject {
  id: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha256?: string;
}

function intendedObject(
  type: IntendedObject["type"],
  body: string | Buffer,
): IntendedObject {
  const size = Buffer.byteLength(body);
  if (size > MAX_STDIN)
    throw new Error("Git object exceeds stdin processing budget");
  const header = `${type} ${size}\0`;
  return {
    id: createHash("sha1").update(header).update(body).digest("hex"),
    type,
    size,
    sha256: createHash("sha256").update(header).update(body).digest("hex"),
  };
}

async function objectFile(repository: string, id: string) {
  const directory = join(repository, "objects", id.slice(0, 2));
  if (await exists(directory)) await ownedDirectory(directory);
  const path = join(directory, id.slice(2));
  if (await exists(path)) {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.()
    ) {
      throw new Error("Unsafe Git object file");
    }
  }
  return path;
}

async function verifyObject(
  repository: string,
  intended: IntendedObject,
  signal?: AbortSignal,
) {
  checkCancelled(signal);
  const path = await objectFile(repository, intended.id);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const input = file.createReadStream({ autoClose: false });
  const deadline = AbortSignal.timeout(30_000);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.size > MAX_STDIN + 1024 * 1024
    ) {
      throw new Error("Unsafe/oversize Git object file");
    }
    const sha1 = createHash("sha1");
    const sha256 = createHash("sha256");
    const max = intended.type === "blob" ? MAX_STDIN : MAX_STDOUT;
    let total = 0;
    let prefix = Buffer.alloc(0);
    let headerLength = 0;
    let size = 0;
    const inflate = createInflate();
    await pipeline(
      input,
      inflate,
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          try {
            total += chunk.length;
            if (total > max + 128)
              throw new Error(
                "Git object integrity verification exceeds processing budget",
              );
            sha1.update(chunk);
            sha256.update(chunk);
            if (headerLength === 0) {
              prefix = Buffer.concat([
                prefix,
                chunk.subarray(0, 128 - prefix.length),
              ]);
              const end = prefix.indexOf(0);
              if (end < 0 && prefix.length === 128)
                throw new Error("Invalid Git object header");
              if (end >= 0) {
                const match = /^(blob|tree|commit) (0|[1-9][0-9]*)$/.exec(
                  prefix.toString("ascii", 0, end),
                );
                if (!match || match[1] !== intended.type)
                  throw new Error("Git object type integrity mismatch");
                size = Number(match[2]);
                if (
                  !Number.isSafeInteger(size) ||
                  size > max ||
                  (intended.size !== undefined && intended.size !== size)
                ) {
                  throw new Error("Git object size integrity mismatch");
                }
                headerLength = end + 1;
              }
            }
            done();
          } catch (error) {
            done(
              error instanceof Error
                ? error
                : new Error("Git object integrity verification failed"),
            );
          }
        },
      }),
      { signal: signal ? AbortSignal.any([signal, deadline]) : deadline },
    );
    if (
      inflate.bytesWritten !== info.size ||
      headerLength === 0 ||
      total !== headerLength + size ||
      sha1.digest("hex") !== intended.id ||
      (intended.sha256 !== undefined &&
        sha256.digest("hex") !== intended.sha256)
    ) {
      throw new Error("Git object content/hash integrity mismatch");
    }
  } catch (error) {
    if (signal?.aborted)
      throw new Error("Git export cancelled", { cause: error });
    if (deadline.aborted) {
      throw new Error("Git object integrity verification exceeded 30 seconds", {
        cause: error,
      });
    }
    throw new Error("Git object integrity verification failed", {
      cause: error,
    });
  } finally {
    input.destroy();
    await file.close();
  }
}

async function inspectLayout(repository: string) {
  for (const name of ["objects", "refs", "refs/heads"]) {
    await ownedDirectory(join(/* turbopackIgnore: true */ repository, name));
  }
  for (const name of ["objects/info", "objects/pack", "refs/tags"]) {
    await emptyDirectory(join(/* turbopackIgnore: true */ repository, name));
  }
  for (const name of await readdir(join(repository, "objects"))) {
    if (!/^(?:[0-9a-f]{2}|info|pack)$/.test(name)) {
      throw new Error("Unverifiable Git object directory layout");
    }
    await ownedDirectory(join(repository, "objects", name));
  }
  if (
    (await readdir(join(repository, "refs"))).some(
      (name) => !["heads", "tags"].includes(name),
    )
  ) {
    throw new Error("Divergent Git refs layout");
  }
  for (const name of await readdir(join(repository, "refs/heads"))) {
    if (
      name !== "main" ||
      !OBJECT.test(
        (await smallFile(join(repository, "refs/heads", name))).text.trim(),
      )
    ) {
      throw new Error("Divergent Git managed refs");
    }
  }
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Git export cancelled");
}

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function privateDirectory(path: string, create = false) {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
  }
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      "Unsafe Git history directory: private mode/owner/path required",
    );
  }
}

function isCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

async function smallFile(path: string, privateMode = false) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (privateMode && (info.mode & 0o777) !== 0o600) ||
      info.size > 4096
    ) {
      throw new Error("Unsafe Git marker/config/lock file");
    }
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096)
      throw new Error("Oversize Git marker/config/lock file");
    return { text: bytes.toString("utf8", 0, bytesRead), info };
  } finally {
    await file.close();
  }
}

async function discardCreatedFile(
  path: string,
  identity: { dev: number; ino: number },
  contents: string,
  publishedAs?: string,
) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    const expected = Buffer.from(contents);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.dev !== identity.dev ||
      info.ino !== identity.ino ||
      info.nlink !== (publishedAs ? 2 : 1) ||
      info.size > expected.length
    ) {
      throw new Error(
        "Owned Git publication artifact changed; cleanup refused",
      );
    }
    if (publishedAs) {
      const marker = await lstat(publishedAs);
      if (
        marker.dev !== info.dev ||
        marker.ino !== info.ino ||
        marker.isSymbolicLink()
      ) {
        throw new Error(
          "Owned Git publication identity changed; cleanup refused",
        );
      }
    }
    const bytes = Buffer.alloc(expected.length + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    // A failed bounded write may have persisted only our exact nonce/content
    // prefix. Exclusive creation plus inode identity distinguishes it from an
    // unknown lock; a published marker must instead match in full.
    if (
      bytesRead > expected.length ||
      !bytes.subarray(0, bytesRead).equals(expected.subarray(0, bytesRead)) ||
      (publishedAs && bytesRead !== expected.length)
    ) {
      throw new Error(
        "Owned Git publication nonce/content changed; cleanup refused",
      );
    }
    await unlink(path);
  } finally {
    await file.close();
  }
}

async function discardFreshEmptyDirectory(
  path: string,
  identity: { dev: number; ino: number },
) {
  const info = await lstat(path);
  if (
    info.dev !== identity.dev ||
    info.ino !== identity.ino ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700 ||
    (await readdir(path)).length !== 0
  )
    return;
  await rmdir(path);
}

async function executable(state: string) {
  // PATH is operator configuration, never a notebook field. Resolve once per
  // admission so an unavailable executable remains a visible, retryable error.
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(
    delimiter,
  )) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, "git");
    if (within(state, candidate) || within(process.cwd(), candidate)) continue;
    try {
      const path = await realpath(candidate);
      if (within(state, path) || within(process.cwd(), path)) continue;
      const info = await lstat(path);
      if (!info.isFile() || (info.mode & 0o022) !== 0) continue;
      await access(path, constants.X_OK);
      return path;
    } catch (error) {
      if (!isCode(error, "ENOENT") && !isCode(error, "EACCES")) throw error;
    }
  }
  throw new Error("Git executable unavailable in trusted operator PATH");
}

class UncertainChildError extends Error {}

async function command(
  program: string,
  repository: string,
  args: string[],
  input: string,
  date: string,
  signal?: AbortSignal,
  accepted = [0],
) {
  checkCancelled(signal);
  if (Buffer.byteLength(input) > MAX_STDIN) {
    throw new Error("Git stdin exceeds the 512 MiB processing budget");
  }
  return new Promise<string>((resolveResult, reject) => {
    const child = spawn(
      program,
      [
        "--no-pager",
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.logAllRefUpdates=false",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        "-c",
        "credential.helper=",
        "-c",
        "protocol.allow=never",
        `--git-dir=${repository}`,
        ...args,
      ],
      {
        cwd: repository,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          NODE_ENV: "production",
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          XDG_CONFIG_HOME: "/nonexistent",
          LC_ALL: "C",
          TZ: "UTC",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_AUTHOR_NAME: "AIRA Nexus",
          GIT_AUTHOR_EMAIL: "notebook-history@aira.local",
          GIT_COMMITTER_NAME: "AIRA Nexus",
          GIT_COMMITTER_EMAIL: "notebook-history@aira.local",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let uncertainTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const stop = (error: Error) => {
      if (closed || failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (closed) return;
        child.kill("SIGKILL");
        uncertainTimer = setTimeout(() => {
          if (!closed)
            reject(
              new UncertainChildError(
                "Git child close uncertain; owned lock retained",
              ),
            );
        }, 2000);
      }, 1000);
    };
    const timeout = setTimeout(
      () => stop(new Error("Git command exceeded 30 seconds")),
      30_000,
    );
    const abort = () => stop(new Error("Git export cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize > MAX_STDOUT) stop(new Error("Git stdout exceeds 2 MiB"));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errSize += chunk.length;
      if (errSize > MAX_STDERR) stop(new Error("Git stderr exceeds 64 KiB"));
      else stderr.push(chunk);
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error);
    });
    child.once("close", (code) => {
      closed = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearTimeout(uncertainTimer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code === null || !accepted.includes(code)) {
        reject(
          new Error(
            `Git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
      } else {
        resolveResult(Buffer.concat(stdout).toString("utf8"));
      }
    });
    child.stdin.end(input, "utf8");
  });
}

function objectId(output: string) {
  const id = output.trim();
  if (!OBJECT.test(id)) throw new Error("Invalid Git object identity");
  return id;
}

function savedContent(event: GitHistoryEvent) {
  if (
    Buffer.byteLength(event.canonicalContent) > MAX_STDIN ||
    !/^[0-9a-f]{64}$/.test(event.sha256) ||
    createHash("sha256")
      .update(event.canonicalContent, "utf8")
      .digest("hex") !== event.sha256
  ) {
    throw new Error(
      "Canonical content hash/integrity mismatch or processing budget exceeded",
    );
  }
  const content: unknown = JSON.parse(event.canonicalContent);
  if (
    !record(content) ||
    typeof content.name !== "string" ||
    !record(content.document)
  ) {
    throw new Error("Invalid canonical notebook envelope");
  }
  const document = content.document;
  if (document.nbformat !== 4 || !Array.isArray(document.cells)) {
    throw new Error("Invalid canonical source notebook");
  }
  for (const cell of document.cells) {
    if (
      !record(cell) ||
      typeof cell.id !== "string" ||
      !["code", "markdown", "raw"].includes(String(cell.cell_type)) ||
      !(
        typeof cell.source === "string" ||
        (Array.isArray(cell.source) &&
          cell.source.every((line) => typeof line === "string"))
      ) ||
      (cell.cell_type === "code" &&
        (!Array.isArray(cell.outputs) ||
          cell.outputs.length !== 0 ||
          cell.execution_count !== null))
    ) {
      throw new Error("Invalid source-only canonical notebook cell");
    }
  }
  return { name: content.name, source: `${JSON.stringify(document)}\n` };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function inspectObjects(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    const info = await lstat(full);
    if (
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) ||
      ["alternates", "http-alternates"].includes(entry.name)
    ) {
      throw new Error("Unsafe Git object/ref path or ownership");
    }
    if (info.isDirectory()) await inspectObjects(full);
  }
}

// @id CODE-NH-GIT @implements REQ-NH-005 REQ-NH-006
export class NotebookGit {
  private readonly admissions = new Map<
    string,
    { dev: number; ino: number; head: string | null }
  >();

  constructor(
    readonly state: string,
    readonly applicationId: string,
  ) {}

  async exportVersion(
    context: GitHistoryContext,
    event: GitHistoryEvent,
    options: {
      expectedParent: string | null;
      prepared?: GitPrepared;
      onPrepared(p: GitPrepared): Promise<void>;
      beforeRefUpdate(): Promise<void>;
      signal?: AbortSignal;
    },
  ): Promise<GitPrepared> {
    checkCancelled(options.signal);
    if (
      !UUID.test(this.applicationId) ||
      !UUID.test(context.applicationId) ||
      !UUID.test(context.projectId) ||
      !UUID.test(context.generationId) ||
      !UUID.test(event.notebookId) ||
      context.applicationId !== this.applicationId ||
      context.projectId !== event.projectId ||
      !/^[1-9][0-9]*$/.test(event.id) ||
      !Number.isSafeInteger(event.revision) ||
      event.revision < 1 ||
      !Number.isFinite(Date.parse(event.recordedAt)) ||
      Date.parse(event.recordedAt) < 0 ||
      (options.expectedParent !== null && !OBJECT.test(options.expectedParent))
    ) {
      throw new Error(
        "Invalid Git UUID, scope, identity, event or expected parent",
      );
    }
    if (
      options.prepared &&
      (options.prepared.parent !== options.expectedParent ||
        !OBJECT.test(options.prepared.tree) ||
        !OBJECT.test(options.prepared.commit))
    ) {
      throw new Error("Prepared Git checkpoint parent/tree/commit mismatch");
    }
    const { source, name } = savedContent(event);
    const descriptor = `${JSON.stringify({
      name,
      id: event.id,
      projectId: event.projectId,
      notebookId: event.notebookId,
      revision: event.revision,
      sha256: event.sha256,
      recordedAt: event.recordedAt,
      origin: event.origin,
      editor: event.editor,
      reason: event.reason,
      proposalId: event.proposalId,
      restoredFrom: event.restoredFrom,
    })}\n`;
    for (const input of [source, descriptor]) {
      if (Buffer.byteLength(input) > MAX_STDIN)
        throw new Error("Git stdin processing budget exceeded");
    }
    const state = resolve(this.state);
    if ((await realpath(state)) !== state)
      throw new Error("Unsafe symlink in Git state path");
    await privateDirectory(state);
    const program = await executable(state);
    const history = join(state, "notebook-history");
    const project = join(history, context.projectId);
    await privateDirectory(history, true);
    await privateDirectory(project, true);
    const repository = join(project, `${context.generationId}.git`);
    const marker = `${JSON.stringify({
      version: 1,
      applicationId: context.applicationId,
      projectId: context.projectId,
      generationId: context.generationId,
    })}\n`;
    let fresh = false;
    try {
      await mkdir(repository, { mode: 0o700 });
      fresh = true;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    const createdIdentity = fresh ? await lstat(repository) : undefined;
    try {
      await privateDirectory(repository);
      const verifyMarker = async () => {
        if ((await realpath(state)) !== state)
          throw new Error("Unsafe symlink in Git state path");
        await privateDirectory(state);
        await privateDirectory(history);
        await privateDirectory(project);
        await privateDirectory(repository);
        try {
          if (
            (await smallFile(join(repository, MARKER), true)).text !== marker
          ) {
            throw new Error("Git marker identity/project/generation mismatch");
          }
        } catch (error) {
          if (isCode(error, "ENOENT"))
            throw new Error("Unmarked Git repository; adoption refused");
          throw error;
        }
      };
      if (!fresh) await verifyMarker();
      checkCancelled(options.signal);
      const nonce = `${JSON.stringify({ nonce: randomUUID() })}\n`;
      const lockPath = join(repository, LOCK);
      let lock: FileHandle;
      try {
        lock = await open(
          lockPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        throw new Error(
          "Git generation lock occupied/unsafe; explicit rebuild required",
          { cause: error },
        );
      }
      const identity = await lock.stat();
      try {
        await lock.writeFile(nonce);
      } catch (error) {
        await discardCreatedFile(lockPath, identity, nonce);
        throw error;
      } finally {
        await lock.close();
      }
      let uncertain = false;
      const ownedLock = async () => {
        const current = await smallFile(lockPath, true);
        if (
          current.text !== nonce ||
          current.info.dev !== identity.dev ||
          current.info.ino !== identity.ino
        ) {
          throw new Error("Git owned lock changed; generation blocked");
        }
      };
      const date = `${Math.floor(Date.parse(event.recordedAt) / 1000)} +0000`;
      const run = (args: string[], input = "", accepted = [0]) =>
        command(
          program,
          repository,
          args,
          input,
          date,
          options.signal,
          accepted,
        );
      try {
        if (fresh) {
          const temporary = join(
            repository,
            `${MARKER}.${randomUUID()}.pending`,
          );
          const file = await open(temporary, "wx", 0o600);
          const pendingIdentity = await file.stat();
          let published = false;
          try {
            await file.writeFile(marker);
            await file.sync();
            checkCancelled(options.signal);
            await link(temporary, join(repository, MARKER));
            published = true;
          } finally {
            await file.close();
            await discardCreatedFile(
              temporary,
              pendingIdentity,
              marker,
              published ? join(repository, MARKER) : undefined,
            );
          }
        }
        await verifyMarker();
        const complete = (
          await Promise.all(
            [
              "HEAD",
              "config",
              "objects",
              "objects/info",
              "objects/pack",
              "refs",
              "refs/heads",
              "refs/tags",
            ].map((name) => exists(join(repository, name))),
          )
        ).every(Boolean);
        if (!complete) {
          await recoverableInitialisation(repository);
          await run([
            "init",
            "--bare",
            "--quiet",
            "--template=",
            "--initial-branch=main",
            repository,
          ]);
          await run(["symbolic-ref", "HEAD", REF]);
        }
        const inspect = async () => {
          await verifyMarker();
          await ownedLock();
          // Only init's minimal bare config is accepted. In particular, even local
          // includes/alternates cannot introduce additional filesystem authority.
          const config = (await smallFile(join(repository, "config"))).text;
          if (!CONFIG.test(config)) {
            throw new Error(
              "Unverifiable Git repository config; unsafe configuration refused",
            );
          }
          if (
            (await smallFile(join(repository, "HEAD"))).text !== `ref: ${REF}\n`
          ) {
            throw new Error("Divergent Git HEAD");
          }
          await inspectLayout(repository);
          for (const name of [
            "packed-refs",
            "shallow",
            "commondir",
            "worktrees",
            "info",
          ]) {
            try {
              await lstat(join(repository, name));
            } catch (error) {
              if (isCode(error, "ENOENT")) continue;
              throw error;
            }
            throw new Error("Unverifiable Git repository layout");
          }
        };
        await inspect();
        const readHead = async () => {
          const value = (
            await run(["rev-parse", "--verify", "--quiet", REF], "", [0, 1])
          ).trim();
          return value ? objectId(value) : null;
        };
        const initialHead = await readHead();
        if (
          initialHead !== options.expectedParent &&
          initialHead !== options.prepared?.commit
        ) {
          throw new Error("Divergent Git HEAD/expected parent");
        }
        const directoryIdentity = await lstat(repository);
        const admission = this.admissions.get(repository);
        // Private immutable objects are trusted only across successful exports by
        // this instance at its exact last head/inode. Restart, error and prepared
        // recovery require a fresh full admission, never arbitrary-history adoption.
        if (
          options.prepared !== undefined ||
          !admission ||
          admission.dev !== directoryIdentity.dev ||
          admission.ino !== directoryIdentity.ino ||
          admission.head !== initialHead
        ) {
          await inspectObjects(join(repository, "objects"));
          await inspectObjects(join(repository, "refs"));
          await run([
            "fsck",
            "--full",
            "--strict",
            "--no-progress",
            "--no-dangling",
          ]);
        }
        const admit = () =>
          this.admissions.set(repository, {
            dev: directoryIdentity.dev,
            ino: directoryIdentity.ino,
            head: commit,
          });
        const intended = new Map<string, IntendedObject>();
        const store = async (
          type: IntendedObject["type"],
          body: string | Buffer,
          args: string[],
          input: string,
        ) => {
          const object = intendedObject(type, body);
          await objectFile(repository, object.id);
          const id = objectId(await run(args, input));
          if (id !== object.id)
            throw new Error("Git intended object identity mismatch");
          intended.set(id, object);
          return id;
        };
        const files = new Map<string, string>();
        if (options.expectedParent !== null) {
          await verifyObject(
            repository,
            { id: options.expectedParent, type: "commit" },
            options.signal,
          );
          const root = objectId(
            await run(["rev-parse", `${options.expectedParent}^{tree}`]),
          );
          await verifyObject(
            repository,
            { id: root, type: "tree" },
            options.signal,
          );
          const rootEntry = /^040000 tree ([0-9a-f]{40})\tnotebooks\0$/.exec(
            await run(["ls-tree", "-z", root]),
          );
          if (!rootEntry) throw new Error("Unverifiable Git parent root tree");
          await verifyObject(
            repository,
            { id: rootEntry[1], type: "tree" },
            options.signal,
          );
          const listing = await run(["ls-tree", "-z", rootEntry[1]]);
          for (const entry of listing.split("\0").filter(Boolean)) {
            const match =
              /^100644 blob ([0-9a-f]{40})\t([0-9a-f-]+\.(?:ipynb|history\.json))$/.exec(
                entry,
              );
            if (
              !match ||
              !UUID.test(match[2].replace(/\.(ipynb|history\.json)$/, ""))
            ) {
              throw new Error("Unverifiable Git parent tree path/mode");
            }
            files.set(match[2], match[1]);
          }
        }
        files.set(
          `${event.notebookId}.ipynb`,
          await store("blob", source, ["hash-object", "-w", "--stdin"], source),
        );
        files.set(
          `${event.notebookId}.history.json`,
          await store(
            "blob",
            descriptor,
            ["hash-object", "-w", "--stdin"],
            descriptor,
          ),
        );
        const entries = [...files].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        for (const [, id] of entries) await objectFile(repository, id);
        const subtree = await store(
          "tree",
          Buffer.concat(
            entries.flatMap(([name, id]) => [
              Buffer.from(`100644 ${name}\0`),
              Buffer.from(id, "hex"),
            ]),
          ),
          ["mktree", "-z"],
          entries.map(([name, id]) => `100644 blob ${id}\t${name}\0`).join(""),
        );
        const tree = await store(
          "tree",
          Buffer.concat([
            Buffer.from("40000 notebooks\0"),
            Buffer.from(subtree, "hex"),
          ]),
          ["mktree", "-z"],
          `040000 tree ${subtree}\tnotebooks\0`,
        );
        const message =
          `Notebook ${event.notebookId} revision ${event.revision}\n\n` +
          `Event ${event.id}\nSHA256 ${event.sha256}\n`;
        const commitBody =
          `tree ${tree}\n` +
          (options.expectedParent ? `parent ${options.expectedParent}\n` : "") +
          `author ${IDENTITY} ${date}\ncommitter ${IDENTITY} ${date}\n\n${message}`;
        const commit = await store(
          "commit",
          commitBody,
          [
            "commit-tree",
            tree,
            ...(options.expectedParent ? ["-p", options.expectedParent] : []),
          ],
          message,
        );
        const prepared: GitPrepared = {
          parent: options.expectedParent,
          tree,
          commit,
        };
        if (
          options.prepared &&
          (options.prepared.commit !== commit || options.prepared.tree !== tree)
        ) {
          throw new Error(
            "Prepared Git checkpoint event/content/tree integrity mismatch",
          );
        }
        const verifyIntended = async () => {
          for (const object of intended.values()) {
            await verifyObject(repository, object, options.signal);
          }
        };
        if (initialHead === commit) {
          await verifyIntended();
          await inspect();
          if ((await readHead()) !== commit)
            throw new Error("Divergent Git HEAD during reconciliation");
          admit();
          return prepared;
        }
        await options.onPrepared({ ...prepared });
        await inspect();
        checkCancelled(options.signal);
        await options.beforeRefUpdate();
        checkCancelled(options.signal);
        await inspect();
        await run([
          "update-ref",
          "--no-deref",
          REF,
          commit,
          options.expectedParent ?? ZERO,
        ]);
        if ((await readHead()) !== commit)
          throw new Error("Git ref verification mismatch");
        await verifyIntended();
        admit();
        return prepared;
      } catch (error) {
        this.admissions.delete(repository);
        uncertain = error instanceof UncertainChildError;
        throw error;
      } finally {
        if (!uncertain) {
          await ownedLock();
          await unlink(lockPath);
        }
      }
    } finally {
      if (createdIdentity)
        await discardFreshEmptyDirectory(repository, createdIdentity);
    }
  }
}
