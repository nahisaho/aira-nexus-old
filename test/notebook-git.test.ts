import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import childProcess, { execFile } from "node:child_process";
import fs from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import {
  NotebookGit,
  type GitHistoryContext,
  type GitHistoryEvent,
  type GitPrepared,
} from "../src/server/notebook-git";

const execute = promisify(execFile);
const emptyEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

async function git(repository: string, ...args: string[]) {
  const { stdout } = await execute(
    "git",
    ["--no-pager", `--git-dir=${repository}`, ...args],
    { env: emptyEnv, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return stdout;
}

function snapshot(name = "実験 / ../../ --upload-pack=evil") {
  return {
    name,
    document: {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { literal: "研究 🧪" },
      cells: [
        {
          id: "markdown-1",
          cell_type: "markdown",
          source:
            "日本語 🧪\n<script>throw new Error('never execute')</script>\n" +
            '<img src="https://research.invalid/private" onerror="alert(1)">\n' +
            "$(touch SHOULD_NOT_EXIST); `touch SHOULD_NOT_EXIST`\n",
          metadata: {},
          attachments: { "sample.txt": { "text/plain": "aGVsbG8=" } },
        },
        {
          id: "python-1",
          cell_type: "code",
          source: "raise RuntimeError('source only; never execute')\n",
          metadata: { aira: { language: "python", sharing: [] } },
          outputs: [],
          execution_count: null,
        },
      ],
    },
  };
}

async function fixture(t: TestContext) {
  // Deliberately inside this checkout, never the live .aira or OS temp directory.
  const root = await mkdtemp(resolve(".notebook-git-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "state");
  await mkdir(state, { mode: 0o700 });
  const context: GitHistoryContext = {
    applicationId: randomUUID(),
    projectId: randomUUID(),
    generationId: randomUUID(),
  };
  const canonicalContent = JSON.stringify(snapshot());
  const event: GitHistoryEvent = {
    id: "41",
    projectId: context.projectId,
    notebookId: randomUUID(),
    revision: 1,
    canonicalContent,
    sha256: createHash("sha256").update(canonicalContent).digest("hex"),
    recordedAt: "2026-11-11T05:00:00.000Z",
    origin: "save",
    editor: "self-declared $(touch SHOULD_NOT_EXIST)",
    reason: "Literal reason\nnot a Git instruction",
    proposalId: null,
    restoredFrom: null,
  };
  const repository = join(
    state,
    "notebook-history",
    context.projectId,
    `${context.generationId}.git`,
  );
  // This real, unrelated repository must never be adopted or modified.
  const foreign = join(root, "foreign.git");
  await git(foreign, "init", "--bare", "--quiet", foreign);
  const exporter = new NotebookGit(state, context.applicationId);
  return { root, state, context, event, repository, foreign, exporter };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const notebookPath = (event: GitHistoryEvent) =>
  `notebooks/${event.notebookId}.ipynb`;
const descriptorPath = (event: GitHistoryEvent) =>
  `notebooks/${event.notebookId}.history.json`;
const lockPath = (f: Fixture) => join(f.repository, ".aira-history.lock");
const noop = async () => {};

async function failInitialisation(t: TestContext, f: Fixture) {
  const spawn = childProcess.spawn;
  let injected = false;
  const mock = t.mock.method(
    childProcess,
    "spawn",
    (...args: Parameters<typeof spawn>) => {
      if (!injected && args[1]?.includes("init")) {
        injected = true;
        return spawn(join(f.root, "temporarily-missing-git"), args[1], args[2]);
      }
      return spawn(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      f.exporter.exportVersion(f.context, f.event, {
        expectedParent: null,
        onPrepared: noop,
        beforeRefUpdate: noop,
      }),
      /ENOENT|not found|unavailable/i,
    );
    assert.equal(injected, true);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
}

async function exported(
  f: Fixture,
  event = f.event,
  expectedParent: string | null = null,
  extra: Partial<Parameters<NotebookGit["exportVersion"]>[2]> = {},
) {
  let result: GitPrepared | undefined;
  await assert.doesNotReject(async () => {
    result = await f.exporter.exportVersion(f.context, event, {
      expectedParent,
      onPrepared: noop,
      beforeRefUpdate: noop,
      ...extra,
    });
  }, "a valid committed snapshot must export to a real isolated bare Git repository");
  assert.ok(result);
  return result;
}

async function head(f: Fixture) {
  return (
    await git(f.repository, "rev-parse", "--verify", "refs/heads/main")
  ).trim();
}

async function verifyCommit(
  f: Fixture,
  prepared: GitPrepared,
  event = f.event,
) {
  assert.equal(await head(f), prepared.commit);
  assert.equal(
    (await git(f.repository, "rev-parse", `${prepared.commit}^{tree}`)).trim(),
    prepared.tree,
  );
  const ancestry = (
    await git(f.repository, "rev-list", "--parents", "-n", "1", prepared.commit)
  )
    .trim()
    .split(" ");
  assert.deepEqual(ancestry, [
    prepared.commit,
    ...(prepared.parent ? [prepared.parent] : []),
  ]);
  const text = await git(
    f.repository,
    "show",
    `${prepared.commit}:${notebookPath(event)}`,
  );
  assert.equal(
    text,
    `${JSON.stringify(JSON.parse(event.canonicalContent).document)}\n`,
  );
  assert.deepEqual(
    JSON.parse(text),
    JSON.parse(event.canonicalContent).document,
  );
  const descriptor = JSON.parse(
    await git(
      f.repository,
      "show",
      `${prepared.commit}:${descriptorPath(event)}`,
    ),
  ) as Record<string, unknown>;
  assert.equal(descriptor.name, JSON.parse(event.canonicalContent).name);
  const { canonicalContent, ...metadata } = event;
  void canonicalContent;
  for (const [key, value] of Object.entries(metadata)) {
    assert.deepEqual(descriptor[key], value, `descriptor must preserve ${key}`);
  }
  const message = await git(
    f.repository,
    "show",
    "-s",
    "--format=%B",
    prepared.commit,
  );
  assert.ok(message.includes(event.id));
  assert.ok(message.includes(event.sha256));
  assert.deepEqual(
    (
      await git(
        f.repository,
        "show",
        "-s",
        "--format=%aI%n%cI",
        prepared.commit,
      )
    )
      .trim()
      .split("\n")
      .map((date) => new Date(date).toISOString()),
    [event.recordedAt, event.recordedAt],
  );
  await git(f.repository, "fsck", "--full", "--no-progress", "--strict");
}

test("TEST-NH-005: known prepublication failures leave the generation retryable", async (t) => {
  for (const stage of ["link", "sync", "cancel", "changed-sync"]) {
    await t.test(stage, async (t) => {
      const f = await fixture(t);
      const controller = new AbortController();
      const originalLink = fs.promises.link;
      const originalOpen = fs.promises.open;
      const originalMkdir = fs.promises.mkdir;
      let faulted = false;
      const mocks = [
        t.mock.method(
          fs.promises,
          "link",
          (...args: Parameters<typeof originalLink>) => {
            if (
              stage === "link" &&
              String(args[1]).endsWith(".aira-history.json")
            ) {
              faulted = true;
              return originalLink(
                args[0],
                join(f.root, "missing-parent", "marker"),
              );
            }
            return originalLink(...args);
          },
        ),
        t.mock.method(
          fs.promises,
          "open",
          async (...args: Parameters<typeof originalOpen>) => {
            const file = await originalOpen(...args);
            if (
              (stage === "sync" || stage === "changed-sync") &&
              String(args[0]).endsWith(".pending")
            ) {
              const sync = file.sync.bind(file);
              t.mock.method(file, "sync", async () => {
                await sync();
                faulted = true;
                if (stage === "changed-sync")
                  await file.write("UNKNOWN", 0, "utf8");
                throw new Error("known prepublication sync failure");
              });
            }
            return file;
          },
        ),
        t.mock.method(
          fs.promises,
          "mkdir",
          async (...args: Parameters<typeof originalMkdir>) => {
            const result = await originalMkdir(...args);
            if (stage === "cancel" && String(args[0]) === f.repository) {
              faulted = true;
              controller.abort();
            }
            return result;
          },
        ),
      ];
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          f.exporter.exportVersion(f.context, f.event, {
            expectedParent: null,
            onPrepared: noop,
            beforeRefUpdate: noop,
            signal: controller.signal,
          }),
          /ENOENT|cancel|publication/i,
        );
        assert.equal(faulted, true);
        await assert.rejects(() =>
          lstat(join(f.repository, ".aira-history.json")),
        );
        await assert.rejects(() => lstat(lockPath(f)));
      } finally {
        for (const mock of mocks) mock.mock.restore();
        syncBuiltinESMExports();
      }
      if (stage === "changed-sync") {
        let entries: string[] = [];
        await assert.doesNotReject(async () => {
          entries = await readdir(f.repository);
        }, "changed publication artifacts must remain untouched");
        const pending = entries.find((name) => name.endsWith(".pending"));
        assert.ok(pending);
        const path = join(f.repository, pending);
        const bytes = await readFile(path, "utf8");
        assert.match(bytes, /^UNKNOWN/);
        await assert.rejects(
          f.exporter.exportVersion(f.context, f.event, {
            expectedParent: null,
            onPrepared: noop,
            beforeRefUpdate: noop,
          }),
          /unmarked|adoption/i,
        );
        assert.equal(await readFile(path, "utf8"), bytes);
        return;
      }
      const retry = await exported(f);
      await verifyCommit(f, retry);
      assert.equal((await git(f.foreign, "for-each-ref")).trim(), "");
    });
  }
});

// @id TEST-NH-005 @verifies REQ-NH-005 REQ-NH-006
// Exporter-only recovery/authority cases also exercise the Git half of REQ-NH-006.
test("TEST-NH-005: local Git export contract", async (t) => {
  await t.test(
    "valid control: literal UTF-8 source, metadata and real Git objects",
    async (t) => {
      const f = await fixture(t);
      const prepared = await exported(f, f.event, null, {
        async onPrepared(p) {
          assert.equal(p.parent, null);
          await assert.rejects(() => head(f));
          assert.equal(
            (await git(f.repository, "cat-file", "-t", p.commit)).trim(),
            "commit",
          );
        },
      });
      await verifyCommit(f, prepared);
      assert.equal(
        (await git(f.repository, "rev-parse", "--is-bare-repository")).trim(),
        "true",
      );
      const files = (
        await git(f.repository, "ls-tree", "-r", "--name-only", prepared.commit)
      )
        .trim()
        .split("\n");
      assert.deepEqual(
        files,
        [descriptorPath(f.event), notebookPath(f.event)].sort(),
      );
      for (const directory of [
        join(f.state, "notebook-history"),
        join(f.state, "notebook-history", f.context.projectId),
        f.repository,
      ]) {
        const info = await lstat(directory);
        assert.equal(info.isSymbolicLink(), false);
        assert.equal(info.mode & 0o777, 0o700);
        if (process.getuid) assert.equal(info.uid, process.getuid());
      }
      assert.equal((await git(f.foreign, "for-each-ref")).trim(), "");
      await assert.rejects(() => lstat(join(f.root, "SHOULD_NOT_EXIST")));
      await assert.rejects(() => lstat(lockPath(f)));
    },
  );

  await t.test(
    "hostile inherited Git configuration cannot execute hooks or filters",
    async (t) => {
      const f = await fixture(t);
      const hooks = join(f.root, "hooks");
      const sentinel = join(f.root, "HOSTILE_COMMAND_EXECUTED");
      await mkdir(hooks);
      const script = `#!/bin/sh\nprintf executed > '${sentinel}'\nexit 1\n`;
      for (const hook of [
        "reference-transaction",
        "post-commit",
        "pre-commit",
      ]) {
        await writeFile(join(hooks, hook), script, { mode: 0o700 });
      }
      const filter = join(f.root, "filter");
      await writeFile(filter, script, { mode: 0o700 });
      const attributes = join(f.root, "attributes");
      await writeFile(attributes, "* filter=hostile\n");
      const config = join(f.root, "hostile.gitconfig");
      await writeFile(
        config,
        `[core]\n hooksPath = ${hooks}\n attributesFile = ${attributes}\n` +
          `[filter "hostile"]\n clean = ${filter}\n required = true\n` +
          `[commit]\n gpgSign = true\n[gpg]\n program = ${filter}\n` +
          `[init]\n defaultBranch = hostile\n`,
      );
      const overrides: Record<string, string> = {
        GIT_DIR: f.foreign,
        GIT_WORK_TREE: f.root,
        GIT_COMMON_DIR: f.foreign,
        GIT_INDEX_FILE: join(f.root, "foreign-index"),
        GIT_OBJECT_DIRECTORY: join(f.foreign, "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(f.foreign, "objects"),
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_SYSTEM: config,
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: hooks,
        GIT_CONFIG_KEY_1: "core.sshCommand",
        GIT_CONFIG_VALUE_1: filter,
        GIT_SSH_COMMAND: filter,
        GIT_ASKPASS: filter,
        GIT_AUTHOR_NAME: "inherited author",
        GIT_AUTHOR_EMAIL: "inherited@invalid",
        GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z",
        GIT_COMMITTER_NAME: "inherited committer",
        GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z",
        HOME: f.root,
        XDG_CONFIG_HOME: f.root,
      };
      const previous = new Map(
        Object.keys(overrides).map((key) => [key, process.env[key]]),
      );
      try {
        Object.assign(process.env, overrides);
        const prepared = await exported(f);
        await verifyCommit(f, prepared);
        assert.notEqual(
          (
            await git(
              f.repository,
              "show",
              "-s",
              "--format=%an",
              prepared.commit,
            )
          ).trim(),
          "inherited author",
        );
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      await assert.rejects(() => lstat(sentinel));
      assert.equal((await git(f.foreign, "for-each-ref")).trim(), "");
      assert.deepEqual(await readdir(join(f.foreign, "objects")), [
        "info",
        "pack",
      ]);
    },
  );

  await t.test(
    "multiple notebooks preserve prior tree entries and rebuild deterministically",
    async (t) => {
      const f = await fixture(t);
      const first = await exported(f);
      const secondEvent = {
        ...f.event,
        id: "42",
        notebookId: randomUUID(),
        origin: "create",
      };
      const second = await exported(f, secondEvent, first.commit);
      await verifyCommit(f, second, secondEvent);
      assert.equal(
        await git(
          f.repository,
          "show",
          `${second.commit}:${notebookPath(f.event)}`,
        ),
        await git(
          f.repository,
          "show",
          `${first.commit}:${notebookPath(f.event)}`,
        ),
      );
      const restoredState = join(f.root, "independent-state");
      await mkdir(restoredState, { mode: 0o700 });
      const rebuilt = new NotebookGit(restoredState, f.context.applicationId);
      const a = await rebuilt.exportVersion(f.context, f.event, {
        expectedParent: null,
        onPrepared: noop,
        beforeRefUpdate: noop,
      });
      const b = await rebuilt.exportVersion(f.context, secondEvent, {
        expectedParent: a.commit,
        onPrepared: noop,
        beforeRefUpdate: noop,
      });
      assert.deepEqual([a, b], [first, second]);
    },
  );

  await t.test(
    "persist preparation before CAS; callback crash resumes the identical dangling commit",
    async (t) => {
      const f = await fixture(t);
      let checkpoint: GitPrepared | undefined;
      await assert.rejects(
        f.exporter.exportVersion(f.context, f.event, {
          expectedParent: null,
          async onPrepared(p) {
            checkpoint = p;
            throw new Error("simulated DB checkpoint interruption");
          },
          beforeRefUpdate: noop,
        }),
        /simulated DB checkpoint interruption/,
      );
      assert.ok(checkpoint);
      await assert.rejects(() => head(f));
      await assert.rejects(() => lstat(lockPath(f)));
      const recovered = await exported(f, f.event, null, {
        prepared: checkpoint,
      });
      assert.deepEqual(recovered, checkpoint);
      await verifyCommit(f, recovered);
    },
  );

  await t.test(
    "lost acknowledgement reconciles exactly once; forged checkpoint and successor refuse",
    async (t) => {
      const f = await fixture(t);
      const prepared = await exported(f);
      const reconciled = await exported(f, f.event, null, { prepared });
      assert.deepEqual(reconciled, prepared);
      assert.equal(
        (
          await git(f.repository, "rev-list", "--count", "refs/heads/main")
        ).trim(),
        "1",
      );
      await assert.rejects(
        f.exporter.exportVersion(f.context, f.event, {
          expectedParent: null,
          prepared: { ...prepared, tree: "0".repeat(40) },
          onPrepared: noop,
          beforeRefUpdate: noop,
        }),
        /prepared|integrity|tree|checkpoint|mismatch/i,
      );
      const next = await exported(
        f,
        { ...f.event, id: "42", revision: 2 },
        prepared.commit,
      );
      await assert.rejects(
        f.exporter.exportVersion(f.context, f.event, {
          expectedParent: null,
          prepared,
          onPrepared: noop,
          beforeRefUpdate: noop,
        }),
        /divergen|parent|head/i,
      );
      assert.equal(await head(f), next.commit);
    },
  );

  await t.test(
    "authority callback refusal and cancellation cannot advance the managed ref",
    async (t) => {
      const f = await fixture(t);
      const first = await exported(f);
      let checkpoint: GitPrepared | undefined;
      const controller = new AbortController();
      await assert.rejects(
        f.exporter.exportVersion(
          f.context,
          { ...f.event, id: "42", revision: 2 },
          {
            expectedParent: first.commit,
            async onPrepared(p) {
              checkpoint = p;
            },
            async beforeRefUpdate() {
              throw new Error("writer authority lost");
            },
          },
        ),
        /writer authority lost/,
      );
      assert.ok(checkpoint);
      assert.equal(await head(f), first.commit);
      await assert.rejects(
        f.exporter.exportVersion(
          f.context,
          { ...f.event, id: "42", revision: 2 },
          {
            expectedParent: first.commit,
            prepared: checkpoint,
            onPrepared: noop,
            async beforeRefUpdate() {
              controller.abort();
            },
            signal: controller.signal,
          },
        ),
        /abort|cancel/i,
      );
      assert.equal(await head(f), first.commit);
      await assert.rejects(() => lstat(lockPath(f)));
      await assert.rejects(
        f.exporter.exportVersion(f.context, f.event, {
          expectedParent: first.commit,
          onPrepared: noop,
          beforeRefUpdate: noop,
          signal: AbortSignal.abort(),
        }),
        /abort|cancel/i,
      );
    },
  );

  await t.test(
    "unknown lock is never deleted, signalled or adopted",
    async (t) => {
      const f = await fixture(t);
      const first = await exported(f);
      const bytes = JSON.stringify({
        pid: process.pid,
        nonce: randomUUID(),
        created: "1900-01-01",
      });
      await writeFile(lockPath(f), bytes, { mode: 0o600, flag: "wx" });
      await assert.rejects(
        f.exporter.exportVersion(
          f.context,
          { ...f.event, id: "42", revision: 2 },
          {
            expectedParent: first.commit,
            onPrepared: noop,
            beforeRefUpdate: noop,
          },
        ),
        /lock|occupied|blocked/i,
      );
      assert.equal(await readFile(lockPath(f), "utf8"), bytes);
      assert.equal(await head(f), first.commit);
    },
  );

  await t.test(
    "cleanup never removes a lock whose nonce changed during an attempt",
    async (t) => {
      const f = await fixture(t);
      const first = await exported(f);
      const replacement = JSON.stringify({
        nonce: randomUUID(),
        pid: process.pid,
      });
      await assert.rejects(
        f.exporter.exportVersion(
          f.context,
          { ...f.event, id: "42", revision: 2 },
          {
            expectedParent: first.commit,
            async onPrepared() {
              await writeFile(lockPath(f), replacement);
              throw new Error("owned lock replaced");
            },
            beforeRefUpdate: noop,
          },
        ),
        /lock|replaced|blocked/i,
      );
      assert.equal(await readFile(lockPath(f), "utf8"), replacement);
      assert.equal(await head(f), first.commit);
    },
  );

  await t.test(
    "CAS refuses a head changed after preparation without resetting it",
    async (t) => {
      const f = await fixture(t);
      const first = await exported(f);
      const competing = (
        await execute(
          "git",
          [
            `--git-dir=${f.repository}`,
            "commit-tree",
            first.tree,
            "-p",
            first.commit,
            "-m",
            "Independent competing commit",
          ],
          {
            env: {
              ...emptyEnv,
              GIT_AUTHOR_NAME: "Control",
              GIT_AUTHOR_EMAIL: "control@invalid",
              GIT_COMMITTER_NAME: "Control",
              GIT_COMMITTER_EMAIL: "control@invalid",
            },
            timeout: 30_000,
          },
        )
      ).stdout.trim();
      await assert.rejects(
        f.exporter.exportVersion(
          f.context,
          { ...f.event, id: "42", revision: 2 },
          {
            expectedParent: first.commit,
            onPrepared: noop,
            async beforeRefUpdate() {
              await git(
                f.repository,
                "update-ref",
                "refs/heads/main",
                competing,
                first.commit,
              );
            },
          },
        ),
        /divergen|compare|ref|lock|parent/i,
      );
      assert.equal(await head(f), competing);
    },
  );

  await t.test(
    "invalid UUIDs, mismatched scope and corrupt canonical hashes refuse",
    async (t) => {
      const f = await fixture(t);
      await exported(f);
      for (const event of [
        { ...f.event, notebookId: "../../foreign.git" },
        { ...f.event, projectId: randomUUID() },
        { ...f.event, sha256: "0".repeat(64) },
        { ...f.event, canonicalContent: `${f.event.canonicalContent} ` },
      ]) {
        await assert.rejects(
          f.exporter.exportVersion(f.context, event, {
            expectedParent: null,
            onPrepared: noop,
            beforeRefUpdate: noop,
          }),
          /uuid|scope|project|hash|integrity|canonical|invalid/i,
        );
      }
      await assert.rejects(
        f.exporter.exportVersion(
          { ...f.context, generationId: "../foreign.git" },
          f.event,
          { expectedParent: null, onPrepared: noop, beforeRefUpdate: noop },
        ),
        /uuid|path|invalid/i,
      );
    },
  );

  await t.test(
    "symlinked managed parent cannot redirect exports into an unrelated directory",
    async (t) => {
      const f = await fixture(t);
      const outside = join(f.root, "outside");
      await mkdir(outside, { mode: 0o700 });
      await symlink(outside, join(f.state, "notebook-history"));
      await assert.rejects(
        f.exporter.exportVersion(f.context, f.event, {
          expectedParent: null,
          onPrepared: noop,
          beforeRefUpdate: noop,
        }),
        /symlink|unsafe|path|owner/i,
      );
      assert.deepEqual(await readdir(outside), []);
    },
  );

  await t.test(
    "unmarked pre-existing bare repository is never adopted",
    async (t) => {
      const f = await fixture(t);
      await mkdir(f.repository, { recursive: true, mode: 0o700 });
      await git(f.repository, "init", "--bare", "--quiet", f.repository);
      const before = await readFile(join(f.repository, "config"), "utf8");
      await assert.rejects(
        f.exporter.exportVersion(f.context, f.event, {
          expectedParent: null,
          onPrepared: noop,
          beforeRefUpdate: noop,
        }),
        /marker|unmarked|adopt|owned/i,
      );
      assert.equal(
        await readFile(join(f.repository, "config"), "utf8"),
        before,
      );
      assert.equal((await git(f.repository, "for-each-ref")).trim(), "");
    },
  );

  await t.test(
    "symlinked lock and repository cannot redirect writes",
    async (t) => {
      const f = await fixture(t);
      const first = await exported(f);
      const sentinel = join(f.root, "do-not-touch");
      await writeFile(sentinel, "unrelated");
      await symlink(sentinel, lockPath(f));
      await assert.rejects(
        f.exporter.exportVersion(f.context, f.event, {
          expectedParent: first.commit,
          onPrepared: noop,
          beforeRefUpdate: noop,
        }),
        /lock|symlink|unsafe|blocked/i,
      );
      assert.equal(await readFile(sentinel, "utf8"), "unrelated");
      assert.equal((await lstat(lockPath(f))).isSymbolicLink(), true);
      const generationId = randomUUID();
      const redirected = join(
        f.state,
        "notebook-history",
        f.context.projectId,
        `${generationId}.git`,
      );
      await symlink(f.foreign, redirected);
      await assert.rejects(
        f.exporter.exportVersion({ ...f.context, generationId }, f.event, {
          expectedParent: null,
          onPrepared: noop,
          beforeRefUpdate: noop,
        }),
        /symlink|unsafe|path|owned/i,
      );
      assert.equal((await git(f.foreign, "for-each-ref")).trim(), "");
    },
  );

  await t.test(
    "same generation rejects another application identity or unsafe directory mode",
    async (t) => {
      const f = await fixture(t);
      const first = await exported(f);
      const applicationId = randomUUID();
      await assert.rejects(
        new NotebookGit(f.state, applicationId).exportVersion(
          { ...f.context, applicationId },
          f.event,
          {
            expectedParent: first.commit,
            onPrepared: noop,
            beforeRefUpdate: noop,
          },
        ),
        /marker|identity|application|owned/i,
      );
      await chmod(f.repository, 0o755);
      await assert.rejects(
        f.exporter.exportVersion(f.context, f.event, {
          expectedParent: first.commit,
          onPrepared: noop,
          beforeRefUpdate: noop,
        }),
        /mode|private|permission|unsafe/i,
      );
      assert.equal(await head(f), first.commit);
    },
  );

  await t.test(
    "corrupt stored snapshot objects cannot be acknowledged on retry",
    async (t) => {
      const f = await fixture(t);
      const prepared = await exported(f);
      const blob = (
        await git(
          f.repository,
          "rev-parse",
          `${prepared.commit}:${notebookPath(f.event)}`,
        )
      ).trim();
      const path = join(
        f.repository,
        "objects",
        blob.slice(0, 2),
        blob.slice(2),
      );
      await chmod(path, 0o600);
      await writeFile(path, deflateSync(Buffer.from("blob 5\0wrong")));
      await assert.rejects(
        f.exporter.exportVersion(f.context, f.event, {
          expectedParent: null,
          prepared,
          onPrepared: noop,
          beforeRefUpdate: noop,
        }),
        /fsck|corrupt|hash|integrity/i,
      );
      assert.equal(await head(f), prepared.commit);
      await assert.rejects(() => lstat(lockPath(f)));
    },
  );

  await t.test(
    "missing operator Git blocks without falling back or creating a repository",
    async (t) => {
      const f = await fixture(t);
      const path = process.env.PATH;
      try {
        process.env.PATH = join(f.root, "no-executables");
        await assert.rejects(
          f.exporter.exportVersion(f.context, f.event, {
            expectedParent: null,
            onPrepared: noop,
            beforeRefUpdate: noop,
          }),
          /Git executable unavailable/i,
        );
      } finally {
        if (path === undefined) delete process.env.PATH;
        else process.env.PATH = path;
      }
      await assert.rejects(() => lstat(f.repository));
      assert.equal((await git(f.foreign, "for-each-ref")).trim(), "");
    },
  );

  await t.test(
    "missing executable at init can retry the same owned empty generation",
    async (t) => {
      const f = await fixture(t);
      await failInitialisation(t, f);
      assert.deepEqual(await readdir(f.repository), [".aira-history.json"]);
      await assert.rejects(() => lstat(lockPath(f)));
      const retry = await exported(f);
      await verifyCommit(f, retry);
    },
  );

  await t.test(
    "only an owned empty partial skeleton may be reinitialised",
    async (t) => {
      const f = await fixture(t);
      await failInitialisation(t, f);
      await mkdir(join(f.repository, "objects", "info"), { recursive: true });
      await mkdir(join(f.repository, "objects", "pack"));
      await mkdir(join(f.repository, "refs", "heads"), { recursive: true });
      await writeFile(join(f.repository, "HEAD"), "ref: refs/heads/main\n");
      const prepared = await exported(f);
      await verifyCommit(f, prepared);
    },
  );

  for (const kind of [
    "object",
    "ref",
    "HEAD",
    "config",
    "marker",
    "unknown",
    "symlink",
    "lock",
  ]) {
    await t.test(
      `partial-init recovery refuses ${kind} evidence without rewriting it`,
      async (t) => {
        const f = await fixture(t);
        await failInitialisation(t, f);
        let path: string;
        let bytes = "pre-existing evidence; never erase";
        if (kind === "object") {
          await mkdir(join(f.repository, "objects", "ab"), { recursive: true });
          path = join(f.repository, "objects", "ab", "c".repeat(38));
        } else if (kind === "ref") {
          await mkdir(join(f.repository, "refs", "heads"), { recursive: true });
          path = join(f.repository, "refs", "heads", "main");
          bytes = `${"a".repeat(40)}\n`;
        } else if (kind === "marker") {
          path = join(f.repository, ".aira-history.json");
          bytes = '{"version":1,"applicationId":"different"}\n';
        } else if (kind === "lock") {
          path = lockPath(f);
          bytes = JSON.stringify({ nonce: randomUUID(), pid: process.pid });
        } else if (kind === "symlink") {
          path = join(f.foreign, "objects", "do-not-touch");
          await symlink(
            join(f.foreign, "objects"),
            join(f.repository, "objects"),
          );
        } else {
          path = join(
            f.repository,
            kind === "unknown" ? "research-do-not-touch" : kind,
          );
        }

        await writeFile(path, bytes);
        await assert.rejects(
          f.exporter.exportVersion(f.context, f.event, {
            expectedParent: null,
            onPrepared: noop,
            beforeRefUpdate: noop,
          }),
          /initial|object|history|marker|config|unsafe|lock|occupied|unverifiable/i,
        );
        assert.equal(await readFile(path, "utf8"), bytes);
        if (kind === "symlink") {
          assert.equal(
            (await lstat(join(f.repository, "objects"))).isSymbolicLink(),
            true,
          );
        }
      },
    );
  }

  for (const damage of ["wrong content", "trailing compressed bytes"]) {
    await t.test(
      `ordinary export verifies ${damage} without a full-history fsck`,
      async (t) => {
        const f = await fixture(t);
        const first = await exported(f);
        const content = snapshot();
        content.document.cells[0].source += "\nchanged source";
        const canonicalContent = JSON.stringify(content);
        const event = {
          ...f.event,
          id: "42",
          revision: 2,
          canonicalContent,
          sha256: createHash("sha256").update(canonicalContent).digest("hex"),
        };
        let prepared: GitPrepared | undefined;
        await assert.rejects(
          f.exporter.exportVersion(f.context, event, {
            expectedParent: first.commit,
            async onPrepared(p) {
              prepared = p;
              const blob = (
                await git(
                  f.repository,
                  "rev-parse",
                  `${p.commit}:${notebookPath(event)}`,
                )
              ).trim();
              const path = join(
                f.repository,
                "objects",
                blob.slice(0, 2),
                blob.slice(2),
              );
              await chmod(path, 0o600);
              await writeFile(
                path,
                damage === "wrong content"
                  ? deflateSync(Buffer.from("blob 5\0wrong"))
                  : Buffer.concat([
                      await readFile(path),
                      Buffer.from("unexpected trailing bytes"),
                    ]),
              );
            },
            beforeRefUpdate: noop,
          }),
          /integrity|hash|corrupt/i,
        );
        assert.ok(prepared);
        await assert.rejects(
          f.exporter.exportVersion(f.context, event, {
            expectedParent: first.commit,
            prepared,
            onPrepared: noop,
            beforeRefUpdate: noop,
          }),
          /fsck|integrity|hash|corrupt/i,
        );
      },
    );
  }

  await t.test(
    "restart admission checks even unreferenced historical object corruption",
    async (t) => {
      const f = await fixture(t);
      const first = await exported(f);
      const raw = Buffer.from("blob 10\0unreferred");
      const id = createHash("sha1").update(raw).digest("hex");
      const directory = join(f.repository, "objects", id.slice(0, 2));
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, id.slice(2)),
        deflateSync(Buffer.from("blob 5\0wrong")),
      );
      const restarted = new NotebookGit(f.state, f.context.applicationId);
      await assert.rejects(
        restarted.exportVersion(
          f.context,
          { ...f.event, id: "42", revision: 2 },
          {
            expectedParent: first.commit,
            onPrepared: noop,
            beforeRefUpdate: noop,
          },
        ),
        /fsck|integrity|hash|corrupt/i,
      );
      assert.equal(await head(f), first.commit);
    },
  );

  await t.test(
    "ordinary successive exports reuse admission, but restart and reconciliation reverify",
    async (t) => {
      const f = await fixture(t);
      const spawn = childProcess.spawn;
      let fscks = 0;
      const mock = t.mock.method(
        childProcess,
        "spawn",
        (...args: Parameters<typeof spawn>) => {
          if (args[1]?.includes("fsck")) fscks += 1;
          return spawn(...args);
        },
      );
      syncBuiltinESMExports();
      try {
        const first = await exported(f);
        assert.equal(
          fscks,
          1,
          "initial admission requires one full verification, not two",
        );
        const secondEvent = { ...f.event, id: "42", revision: 2 };
        const second = await exported(f, secondEvent, first.commit);
        assert.equal(
          fscks,
          1,
          "ordinary successor must not rewalk all retained objects",
        );
        const thirdEvent = { ...f.event, id: "43", revision: 3 };
        const restarted = new NotebookGit(f.state, f.context.applicationId);
        const third = await restarted.exportVersion(f.context, thirdEvent, {
          expectedParent: second.commit,
          onPrepared: noop,
          beforeRefUpdate: noop,
        });
        assert.equal(
          fscks,
          2,
          "a new exporter must strongly admit existing history",
        );
        await restarted.exportVersion(f.context, thirdEvent, {
          expectedParent: second.commit,
          prepared: third,
          onPrepared: noop,
          beforeRefUpdate: noop,
        });
        assert.equal(
          fscks,
          3,
          "ref-before-ack reconciliation requires strong verification",
        );
        await verifyCommit(f, third, thirdEvent);
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
      }
    },
  );
});
