import type { TestContext } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { testDatabase } from "./database";
import { connectDatabase } from "../../src/server/database";
import { Operations } from "../../src/server/operations";
import { Sessions } from "../../src/server/sessions";
import { Projects } from "../../src/server/projects";
import { projectRoutes } from "../../src/server/project-routes";
import { FileStorage, storageDirectory } from "../../src/server/file-storage";
import { Files } from "../../src/server/files";
import { Provenance } from "../../src/server/provenance";
import { Notebooks } from "../../src/server/notebooks";
import { Confirmations } from "../../src/server/confirmations";
import { Sources } from "../../src/server/sources";

export async function settingsFixture(t: TestContext) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
  });
  const db = await testDatabase();
  cleanup.push(() => db.cleanup());
  const operations = new Operations(db.state, db.credentials);
  cleanup.push(() => operations.close());
  await operations.acquire();
  const sessions = new Sessions(operations, db.state, db.credentials);
  cleanup.push(() => sessions.close());
  const projects = new Projects(operations, sessions, db.state, db.credentials);
  cleanup.push(() => projects.close());
  const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
  cleanup.push(() => admin.end());
  const project = await projects.create("local", { name: "Visible project" });
  const foreign = await projects.create("other", { name: "Other owner" });
  return {
    ...db,
    operations,
    sessions,
    projects,
    admin,
    project,
    foreign,
    cleanup,
    route: projectRoutes(projects),
    async intent() {
      const fingerprint = createHash("sha256")
        .update(randomUUID())
        .digest("hex");
      return {
        purpose: "chat" as const,
        fingerprint,
        requestId: randomUUID(),
        grantId: await operations.grant("local", "chat", fingerprint),
      };
    },
  };
}
export function settingsRequest(path: string, method = "GET", body?: unknown) {
  return new Request(`http://localhost:43111${path}`, {
    method,
    headers: {
      Host: "localhost:43111",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
export async function researchFixture(
  f: Awaited<ReturnType<typeof settingsFixture>>,
) {
  const storage = new FileStorage(await storageDirectory(f.state));
  await storage.initialize();
  const files = new Files(f.operations, storage, f.state, f.credentials);
  f.cleanup.push(() => files.close());
  const provenance = new Provenance(
    f.operations,
    files,
    f.state,
    f.credentials,
  );
  f.cleanup.push(() => provenance.close());
  const notebooks = new Notebooks(
    f.operations,
    provenance,
    {
      async epoch() {
        return null;
      },
      async invalidate() {},
    },
    f.state,
    f.credentials,
  );
  f.cleanup.push(() => notebooks.close());
  const bytes = Buffer.from("Retained immutable research");
  const file = await files.upload(
    "local",
    f.project.id,
    "evidence.txt",
    "text/plain",
    (async function* () {
      yield bytes;
    })(),
  );
  const notebook = await notebooks.create("local", f.project.id, {
    name: "Retained notebook",
    document: {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: "Evidence",
          cell_type: "markdown",
          source: "Retained source",
          metadata: {},
        },
      ],
    },
  });
  const confirmations = new Confirmations(
    f.operations,
    notebooks,
    files,
    provenance,
    f.state,
    f.credentials,
    { imageDigest: "sha256:" + "a".repeat(64) },
  );
  f.cleanup.push(() => confirmations.close());
  const sources = new Sources(files, provenance, confirmations);
  return {
    files,
    notebooks,
    file,
    notebook,
    services: {
      operations: f.operations,
      sessions: f.sessions,
      files,
      notebooks,
      sources,
    },
  };
}
