import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  writeFile,
  open,
  unlink,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import sharp from "sharp";
import { testDatabase } from "./helpers/database";
import { browserFixture } from "./helpers/browser";
import { connectDatabase } from "../src/server/database";
import { Operations } from "../src/server/operations";
import { Sessions } from "../src/server/sessions";
import { Files, type FileVersion } from "../src/server/files";
import { FileStorage, storageDirectory } from "../src/server/file-storage";
import { fileRoutes } from "../src/server/file-routes";
import { previewFile } from "../src/server/file-preview";
import { ServiceError } from "../src/server/http";
import { svgPreview, withImageRasterization } from "../src/server/svg-preview";

const MiB = 1024 * 1024;
const status = (n: number) => (error: unknown) =>
  error instanceof ServiceError && error.status === n;
async function* bytes(size: number, fill = 0x5a) {
  for (let offset = 0; offset < size; offset += 512 * 1024)
    yield Buffer.alloc(Math.min(512 * 1024, size - offset), fill);
}
async function digest(source: AsyncIterable<Uint8Array>) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of source) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { size, sha256: hash.digest("hex") };
}
async function responseBytes(response: Response) {
  const reader = response.body!.getReader();
  async function* chunks() {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  return digest(chunks());
}
async function fixture(t: TestContext) {
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const action of cleanup.reverse()) await action();
  });
  const db = await testDatabase();
  cleanup.push(() => db.cleanup());
  const operations = new Operations(db.state, db.credentials);
  cleanup.push(() => operations.close());
  await operations.acquire();
  const sessions = new Sessions(operations, db.state, db.credentials);
  cleanup.push(() => sessions.close());
  const project = await sessions.createProject("local", "file fixture");
  const foreign = await sessions.createProject(
    "other",
    "private foreign fixture",
  );
  const storage = new FileStorage(await storageDirectory(db.state));
  await storage.initialize();
  const files = new Files(operations, storage, db.state, db.credentials);
  cleanup.push(() => files.close());
  const admin = await connectDatabase(db.state, db.credentials, "bootstrap");
  cleanup.push(() => admin.end());
  async function seed(
    name: string,
    source: AsyncIterable<Uint8Array>,
    mime = "application/octet-stream",
    actor = "local",
    projectId = project.id,
  ): Promise<FileVersion> {
    const blob = await storage.create(),
      hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of source) {
        await blob.handle.writeFile(chunk);
        size += chunk.length;
        hash.update(chunk);
      }
      await blob.handle.sync();
    } finally {
      await blob.handle.close();
    }
    await storage.publish(blob.id);
    const version = {
      id: randomUUID(),
      actor,
      projectId,
      name,
      mime,
      size,
      sha256: hash.digest("hex"),
      blobId: blob.id,
    };
    await admin.query(
      "INSERT INTO file_versions(id,project_id,actor,name,mime,size,sha256,blob_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        version.id,
        projectId,
        actor,
        name,
        mime,
        size,
        version.sha256,
        version.blobId,
      ],
    );
    return version;
  }
  const seedBuffer = (name: string, buffer: Uint8Array, mime: string) =>
    seed(
      name,
      (async function* () {
        yield buffer;
      })(),
      mime,
    );
  return {
    ...db,
    operations,
    sessions,
    project,
    foreign,
    storage,
    files,
    admin,
    seed,
    seedBuffer,
    cleanup,
  };
}

/** @id TEST-DATA-005 @verifies REQ-DATA-004 */
test(
  "TEST-DATA-005 image routes bound overlapping rasterization and refuse queue overflow",
  { timeout: 120000 },
  async (t) => {
    await t.test("actual image routes share bounded admission", async (t) => {
      const f = await fixture(t);
      const file = await f.seedBuffer(
        "bounded.svg",
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>',
        ),
        "image/svg+xml",
      );
      const png = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "#ffffff" },
      })
        .png()
        .toBuffer();
      const raster = await f.seedBuffer("bounded.png", png, "image/png");
      let markMetadataReady!: () => void;
      const metadataReady = new Promise<void>((resolve) => {
        markMetadataReady = resolve;
      });
      let inspected = 0;
      let active = 0;
      let peak = 0;
      let draining = false;
      const releases: (() => void)[] = [];
      t.mock.method(sharp.prototype, "metadata", async () => {
        if (++inspected === 12) markMetadataReady();
        await metadataReady;
        return { width: 2, height: 2, format: "svg" };
      });
      t.mock.method(sharp.prototype, "toBuffer", async () => {
        peak = Math.max(peak, ++active);
        try {
          if (!draining)
            await new Promise<void>((resolve) => releases.push(resolve));
          return png;
        } finally {
          active--;
        }
      });
      const route = fileRoutes(f.files);
      const completed: Response[] = [];
      const requests = Array.from({ length: 12 }, (_, index) =>
        route(
          new Request(
            `http://localhost:43111/api/projects/${f.project.id}/files/${index % 2 ? raster.id : file.id}/image`,
            { headers: { Host: "localhost:43111" } },
          ),
        ).then((response) => {
          completed.push(response);
          return response;
        }),
      );
      try {
        await metadataReady;
        await setImmediate();
        assert.equal(peak, 2, "only two native rasterizations may overlap");
        assert.equal(
          completed.length,
          2,
          "two excess requests must refuse instead of queueing",
        );
        for (const response of completed) {
          assert.equal(response.status, 503);
          assert.match(await response.clone().text(), /IMAGE_PREVIEW_BUSY/);
        }
      } finally {
        draining = true;
        for (const release of releases) release();
        await Promise.all(requests);
      }
      assert.equal(
        completed.filter((response) => response.status === 200).length,
        10,
      );
      assert.equal(peak, 2);
      const restored = await route(
        new Request(
          `http://localhost:43111/api/projects/${f.project.id}/files/${file.id}/image`,
          { headers: { Host: "localhost:43111" } },
        ),
      );
      assert.equal(
        restored.status,
        200,
        "settled work must release its admission",
      );
      const canceled = new AbortController();
      canceled.abort();
      for (const version of [file, raster]) {
        const aborted = await route(
          new Request(
            `http://localhost:43111/api/projects/${f.project.id}/files/${version.id}/image`,
            { headers: { Host: "localhost:43111" }, signal: canceled.signal },
          ),
        );
        assert.equal(aborted.status, 409);
        assert.match(await aborted.text(), /IMAGE_PREVIEW_CANCELLED/);
      }
    });
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    await t.test("FIFO release survives rasterization failure", async () => {
      const gates = Array.from({ length: 10 }, deferred);
      const started: number[] = [];
      const jobs = gates.map((gate, index) =>
        withImageRasterization(async () => {
          started.push(index);
          await gate.promise;
          if (index === 3) throw new Error("CONTROLLED_RASTER_FAILURE");
          return index;
        }),
      );
      const settled = Promise.allSettled(jobs);
      try {
        await setImmediate();
        assert.deepEqual(started, [0, 1]);
        await assert.rejects(
          withImageRasterization(async () => 11),
          status(503),
        );
        for (let index = 0; index < gates.length; index++) {
          const deadline = Date.now() + 5000;
          while (!started.includes(index)) {
            assert.ok(Date.now() < deadline, "FIFO admission did not advance");
            await setImmediate();
          }
          gates[index].resolve();
        }
      } finally {
        gates.forEach((gate) => gate.resolve());
        await settled;
      }
      assert.deepEqual(
        started,
        gates.map((_, index) => index),
      );
      assert.equal((await settled)[3].status, "rejected");
      assert.equal(
        await withImageRasterization(async () => "reused"),
        "reused",
      );
    });
    await t.test(
      "queue expires at ten seconds without starting expired work",
      async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const gate = deferred();
        const active = [
          withImageRasterization(() => gate.promise),
          withImageRasterization(() => gate.promise),
        ];
        let started = false;
        let expiry: unknown;
        const queued = withImageRasterization(async () => {
          started = true;
        }).catch((error: unknown) => {
          expiry = error;
        });
        try {
          await setImmediate();
          assert.equal(started, false);
          t.mock.timers.tick(9999);
          await setImmediate();
          assert.equal(expiry, undefined);
          t.mock.timers.tick(1);
          await setImmediate();
          assert.ok(status(503)(expiry), "ten-second waiter must expire");
          assert.equal(started, false);
        } finally {
          gate.resolve();
          await Promise.all([...active, queued]);
        }
        assert.equal(
          await withImageRasterization(async () => "reused"),
          "reused",
        );
      },
    );
    await t.test(
      "queued and active cancellation retain exactly their own slots",
      async () => {
        const first = deferred(),
          second = deferred();
        const running = new AbortController();
        const canceled = new AbortController();
        const a = withImageRasterization(() => first.promise, running.signal);
        const resultA = Promise.allSettled([a]);
        const b = withImageRasterization(() => second.promise);
        let canceledStarted = false,
          nextStarted = false;
        const waiting = withImageRasterization(async () => {
          canceledStarted = true;
        }, canceled.signal);
        let waitingError: unknown;
        const waitingResult = Promise.allSettled([
          waiting.catch((error: unknown) => {
            waitingError = error;
            throw error;
          }),
        ]);
        const next = withImageRasterization(async () => {
          nextStarted = true;
        });
        try {
          canceled.abort();
          await setImmediate();
          assert.equal(canceledStarted, false);
          assert.ok(
            status(409)(waitingError),
            "queued abort must reject immediately",
          );
          assert.equal((await waitingResult)[0].status, "rejected");
          running.abort();
          await setImmediate();
          assert.equal(
            nextStarted,
            false,
            "active native work still owns its slot",
          );
          first.resolve();
          await next;
          assert.equal(nextStarted, true);
          const outcome = (await resultA)[0];
          assert.equal(outcome.status, "rejected");
          if (outcome.status === "rejected")
            assert.ok(status(409)(outcome.reason));
        } finally {
          first.resolve();
          second.resolve();
          await Promise.all([resultA, b, waitingResult, next]);
        }
        const alreadyCanceled = new AbortController();
        alreadyCanceled.abort();
        await assert.rejects(
          withImageRasterization(
            async () => assert.fail("aborted work started"),
            alreadyCanceled.signal,
          ),
          status(409),
        );
        assert.equal(
          await withImageRasterization(async () => "reused"),
          "reused",
        );
      },
    );
  },
);

/** @id TEST-DATA-004 @verifies REQ-DATA-004 */
test(
  "TEST-DATA-004 Markdown image route enforces ownership and bounded inert SVG rasterization",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90"><rect width="160" height="90" fill="#dbeafe"/><text x="20" y="50" font-size="24">Demo</text></svg>';
    const file = await f.seedBuffer(
      "diagram.svg",
      Buffer.from(svg),
      "image/svg+xml",
    );
    const route = fileRoutes(f.files);
    const request = (project: string, id: string, action: string) =>
      new Request(
        `http://localhost:43111/api/projects/${project}/files/${id}/${action}`,
        { headers: { Host: "localhost:43111" } },
      );
    const response = await route(request(f.project.id, file.id, "image"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      response.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    const png = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(png).metadata();
    assert.equal(metadata.width, 160);
    assert.equal(metadata.height, 90);
    assert.equal(
      (await route(request(f.project.id, file.id, "preview"))).status,
      415,
    );
    const download = await route(request(f.project.id, file.id, "download"));
    assert.equal(await download.text(), svg);
    assert.equal(
      (await route(request(f.foreign.id, file.id, "image"))).status,
      404,
    );
    const other = await f.sessions.createProject(
      "local",
      "Other image project",
    );
    assert.equal(
      (await route(request(other.id, file.id, "image"))).status,
      404,
    );
    const raster = await f.seedBuffer("diagram.png", png, "image/png");
    assert.equal(
      (await route(request(f.project.id, raster.id, "image"))).status,
      200,
    );
    const fake = await f.seedBuffer("fake.png", Buffer.from(svg), "image/png");
    assert.equal(
      (await route(request(f.project.id, fake.id, "image"))).status,
      415,
    );
    for (const unsafe of [
      "<script>alert(1)</script>",
      "<foreignObject><p>HTML</p></foreignObject>",
      '<image href="https://blocked.invalid/pixel.png"/>',
      '<image href="file:///etc/passwd"/>',
      '<use href="#external"/>',
      '<style>@import "https://blocked.invalid/style";</style>',
      '<rect width="10" height="10" onload="alert(1)"/>',
      '<rect width="10" height="10" fill="url(https://blocked.invalid/pixel)"/>',
      '<animate attributeName="href" values="javascript:alert(1)"/>',
    ]) {
      await assert.rejects(
        svgPreview(Buffer.from(svg.replace("</svg>", `${unsafe}</svg>`))),
        status(415),
      );
    }
    await assert.rejects(
      svgPreview(
        Buffer.from(
          `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>${svg}`,
        ),
      ),
      status(415),
    );
    await assert.rejects(svgPreview(Buffer.alloc(256 * 1024 + 1)), status(413));
    await assert.rejects(
      svgPreview(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="8193" height="1"/>',
        ),
      ),
      status(413),
    );
    await assert.rejects(
      svgPreview(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${"<rect/>".repeat(2000)}</svg>`,
        ),
      ),
      status(413),
    );
    await t.test(
      "valid viewBox-only SVG resolves bounded dimensions",
      async () => {
        const image = await svgPreview(
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 3"><rect width="7" height="3"/></svg>',
          ),
        );
        const dimensions = await sharp(image).metadata();
        assert.equal(dimensions.width, 7);
        assert.equal(dimensions.height, 3);
      },
    );
    await t.test("invalid UTF-8 is unsupported, not repaired", async () => {
      await assert.rejects(
        svgPreview(Buffer.concat([Buffer.from(svg), Buffer.from([0xc0])])),
        status(415),
      );
    });
    await t.test(
      "malformed XML is not repaired into a successful image",
      async () => {
        for (const source of [
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><g></svg>',
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="1" height="1"></svg>',
          '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" width="3"/>',
        ])
          await assert.rejects(svgPreview(Buffer.from(source)), status(422));
      },
    );
    await t.test(
      "unresolvable SVG dimensions are malformed, not over budget",
      async () => {
        for (const source of [
          '<svg xmlns="http://www.w3.org/2000/svg"/>',
          '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="2"/>',
        ])
          await assert.rejects(svgPreview(Buffer.from(source)), status(422));
      },
    );
    await t.test(
      "exact SVG byte and element budgets retain valid controls",
      async () => {
        const atByteLimit = svg.replace(
          "</svg>",
          `${" ".repeat(256 * 1024 - Buffer.byteLength(svg))}</svg>`,
        );
        assert.equal(Buffer.byteLength(atByteLimit), 256 * 1024);
        await svgPreview(Buffer.from(atByteLimit));
        await assert.rejects(
          svgPreview(Buffer.from(atByteLimit + " ")),
          status(413),
        );
        const shapes = `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2">${'<rect width="1" height="1"/>'.repeat(1999)}</svg>`;
        await svgPreview(Buffer.from(shapes));
        await assert.rejects(
          svgPreview(Buffer.from(shapes.replace("</svg>", "<rect/></svg>"))),
          status(413),
        );
      },
    );
  },
);

/** @id TEST-DATA-001 @verifies REQ-DATA-001 */
test(
  "TEST-DATA-001 real100MiB immutable upload/download, plus-one and aborted/archive cleanup",
  { timeout: 600000 },
  async (t) => {
    const f = await fixture(t);
    for (const published of [false, true]) {
      const stale = await f.storage.create();
      await stale.handle.writeFile(Buffer.alloc(31));
      await stale.handle.sync();
      await stale.handle.close();
      if (published) await f.storage.publish(stale.id);
      await f.admin.query(
        "INSERT INTO file_reservations(id,actor,project_id,epoch,bytes) SELECT $1,'local',$2,epoch-1,31 FROM writer_control",
        [stale.id, f.project.id],
      );
    }
    const http = await browserFixture(fileRoutes(f.files));
    f.cleanup.push(() => http.close());
    let version: FileVersion | undefined;
    await assert.doesNotReject(async () => {
      const source = bytes(100 * MiB);
      const init = {
        method: "POST",
        headers: {
          Origin: http.origin,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(100 * MiB),
        },
        duplex: "half",
        body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await source.next();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          async cancel() {
            await source.return();
          },
        }),
      };
      const response = await fetch(
        `${http.origin}/api/projects/${f.project.id}/files?name=${encodeURIComponent("研究.bin")}`,
        init,
      );
      assert.equal(response.status, 201);
      const uploaded: unknown = await response.json();
      assert.ok(
        uploaded &&
          typeof uploaded === "object" &&
          "id" in uploaded &&
          typeof uploaded.id === "string",
      );
      version = await f.files.get("local", f.project.id, uploaded.id);
      assert.deepEqual(uploaded, version);
    });
    assert.ok(version);
    assert.deepEqual(
      { size: version.size, sha256: version.sha256 },
      await digest(bytes(100 * MiB)),
    );
    const response = await fileRoutes(f.files)(
      new Request(
        `http://localhost/api/projects/${f.project.id}/files/${version.id}/download`,
        { headers: { Host: "localhost" } },
      ),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await responseBytes(response), {
      size: version.size,
      sha256: version.sha256,
    });
    const second = await f.files.upload(
      "local",
      f.project.id,
      "研究.bin",
      "application/octet-stream",
      bytes(3),
    );
    assert.notEqual(second.id, version.id);
    const obsolete = await f.files.reserve("local", f.project.id);
    await f.admin.query(
      "UPDATE file_reservations SET epoch=epoch-1 WHERE id=$1",
      [obsolete],
    );
    await assert.rejects(
      f.files.grow("local", f.project.id, obsolete, 1),
      status(409),
    );
    await f.files.release("local", obsolete);
    const loseReservation = (async function* () {
      yield Buffer.alloc(17);
      await f.admin.query(
        "UPDATE file_reservations SET epoch=epoch-1 WHERE project_id=$1",
        [f.project.id],
      );
    })();
    await assert.rejects(
      f.files.upload(
        "local",
        f.project.id,
        "old-reservation",
        "text/plain",
        loseReservation,
      ),
      status(409),
    );
    assert.equal(
      (await f.files.get("local", f.project.id, version.id)).sha256,
      version.sha256,
    );
    for (const name of [
      "../evil",
      "a/b",
      "a\\b",
      ".",
      "..",
      "CON.txt",
      "a\r\nb",
      "\uD800",
    ]) {
      await assert.rejects(
        f.files.upload("local", f.project.id, name, "text/plain", bytes(1)),
        status(400),
      );
    }
    await assert.rejects(
      f.files.upload(
        "local",
        f.project.id,
        "oversize",
        "application/octet-stream",
        bytes(100 * MiB + 1),
      ),
      status(413),
    );
    const aborted = (async function* () {
      yield Buffer.alloc(17);
      throw new Error("owned synthetic source disconnected");
    })();
    await assert.rejects(
      f.files.upload("local", f.project.id, "aborted", "text/plain", aborted),
      /owned synthetic source disconnected/,
    );
    const archiveDuring = (async function* () {
      yield Buffer.alloc(3);
      await f.admin.query("UPDATE projects SET status='archived' WHERE id=$1", [
        f.project.id,
      ]);
      yield Buffer.alloc(2);
    })();
    await assert.rejects(
      f.files.upload(
        "local",
        f.project.id,
        "archived",
        "text/plain",
        archiveDuring,
      ),
      status(409),
    );
    await f.admin.query("UPDATE projects SET status='active' WHERE id=$1", [
      f.project.id,
    ]);
    const archiveAtPublication = (async function* () {
      yield Buffer.alloc(17);
      await f.admin.query("UPDATE projects SET status='archived' WHERE id=$1", [
        f.project.id,
      ]);
    })();
    await assert.rejects(
      f.files.upload(
        "local",
        f.project.id,
        "late-archive",
        "text/plain",
        archiveAtPublication,
      ),
      status(409),
    );
    assert.equal((await f.files.list("local", f.project.id)).length, 2);
    assert.equal(
      (await f.admin.query("SELECT count(*)::int AS n FROM file_reservations"))
        .rows[0].n,
      0,
    );
    assert.equal((await readdir(join(f.storage.root, "pending"))).length, 0);
    assert.equal((await readdir(join(f.storage.root, "blobs"))).length, 2);
    const app = await connectDatabase(f.state, f.credentials, "application");
    try {
      await assert.rejects(
        app.query("UPDATE file_versions SET name='changed' WHERE id=$1", [
          version.id,
        ]),
        (e) => e instanceof Error && "code" in e && e.code === "42501",
      );
    } finally {
      await app.end();
    }
  },
);

/** @id TEST-DATA-002 @verifies REQ-DATA-002 */
test(
  "TEST-DATA-002 real256MiB verified staging, foreign/collision/overflow and pending quota races",
  { timeout: 600000 },
  async (t) => {
    const f = await fixture(t);
    const versions = [
      await f.seed("one", bytes(100 * MiB)),
      await f.seed("two", bytes(100 * MiB, 0x61)),
      await f.seed("three", bytes(56 * MiB, 0x62)),
    ];
    const selections = versions.map((v, i) => ({
      id: v.id,
      name: `input${i}.bin`,
    }));
    let selected: Awaited<ReturnType<Files["select"]>> | undefined;
    await assert.doesNotReject(async () => {
      selected = await f.files.select("local", f.project.id, selections);
    });
    assert.equal(
      selected!.reduce((n, v) => n + v.size, 0),
      256 * MiB,
    );
    const target = join(f.state, "workspace");
    await mkdir(target, { mode: 0o700 });
    await f.files.stage("local", f.project.id, selections, target);
    for (let i = 0; i < versions.length; i++)
      assert.deepEqual(
        await digest(createReadStream(join(target, selections[i].name))),
        { size: versions[i].size, sha256: versions[i].sha256 },
      );
    const plusOne = await f.seed("extra", bytes(1));
    await assert.rejects(
      f.files.select("local", f.project.id, [
        ...selections,
        { id: plusOne.id, name: "extra" },
      ]),
      status(413),
    );
    await assert.rejects(
      f.files.select("local", f.project.id, [
        { id: versions[0].id, name: "same" },
        { id: versions[1].id, name: "same" },
      ]),
      status(409),
    );
    const foreign = await f.seed(
      "foreign",
      bytes(1),
      "text/plain",
      "other",
      f.foreign.id,
    );
    await assert.rejects(
      f.files.select("local", f.project.id, [{ id: foreign.id, name: "x" }]),
      status(404),
    );
    await assert.rejects(
      f.files.select("local", f.project.id, [
        { id: versions[0].id, name: "../escape" },
      ]),
      status(400),
    );
    const tampered = await open(f.storage.path(plusOne.blobId), "r+");
    await tampered.write(Buffer.from([0]));
    await tampered.close();
    await assert.rejects(
      f.files.select("local", f.project.id, [
        { id: plusOne.id, name: "tampered" },
      ]),
      status(503),
    );
    await assert.rejects(
      f.files.stage("local", f.project.id, selections, target),
      status(409),
    );
    assert.deepEqual(
      await digest(createReadStream(join(target, selections[0].name))),
      { size: versions[0].size, sha256: versions[0].sha256 },
    );
    const partial = join(f.state, "partial-workspace");
    await mkdir(partial, { mode: 0o700 });
    await writeFile(join(partial, selections[1].name), "preserve", {
      mode: 0o600,
    });
    await assert.rejects(
      f.files.stage("local", f.project.id, selections, partial),
      status(409),
    );
    assert.deepEqual(await readdir(partial), [selections[1].name]);
    assert.equal(
      await readFile(join(partial, selections[1].name), "utf8"),
      "preserve",
    );
    const repair = await open(f.storage.path(plusOne.blobId), "r+");
    await repair.write(Buffer.from([0x5a]));
    await repair.close();
    const verify = f.storage.verify.bind(f.storage);
    f.storage.verify = async (id, size, hash) => {
      await verify(id, size, hash);
      if (id === plusOne.blobId) {
        const change = await open(f.storage.path(id), "r+");
        try {
          await change.write(Buffer.from([0]));
        } finally {
          await change.close();
        }
      }
    };
    const changed = join(f.state, "changed-workspace");
    await mkdir(changed, { mode: 0o700 });
    try {
      await assert.rejects(
        f.files.stage(
          "local",
          f.project.id,
          [{ id: plusOne.id, name: "changed" }],
          changed,
        ),
        status(503),
      );
      assert.deepEqual(await readdir(changed), []);
    } finally {
      f.storage.verify = verify;
    }
    const reservationIds = [];
    for (let i = 0; i < 17; i++) {
      const id = await f.files.reserve("local", f.project.id);
      await f.files.grow("local", f.project.id, id, 100 * MiB);
      reservationIds.push(id);
    }
    const remaining = 2 * 1024 * MiB - (256 * MiB + 1) - 1700 * MiB;
    const a = await f.files.reserve("local", f.project.id),
      b = await f.files.reserve("local", f.project.id);
    const races = await Promise.allSettled([
      f.files.grow("local", f.project.id, a, remaining),
      f.files.grow("local", f.project.id, b, 1),
    ]);
    assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = races.filter((r) => r.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.ok(status(413)(rejected[0].reason));
    for (const id of [...reservationIds, a, b])
      await f.files.release("local", id);
  },
);

/** @id TEST-DATA-003 @verifies REQ-DATA-003 */
test(
  "TEST-DATA-003 real decoder limits, literal previews and hostile exact attachment browser controls",
  { timeout: 600000 },
  async (t) => {
    const f = await fixture(t);
    const text = await f.seedBuffer(
      "data.csv",
      Buffer.from(
        "x\n<script>alert(1)</script>\n![remote](https://foreign.invalid/a)",
      ),
      "text/csv",
    );
    let preview: Awaited<ReturnType<typeof previewFile>> | undefined;
    await assert.doesNotReject(async () => {
      preview = await previewFile(f.files, "local", f.project.id, text.id);
    });
    assert.ok(preview?.kind === "text");
    assert.match(preview.text, /<script>/);
    const largeText = await f.seed(
      "large.txt",
      bytes(64 * 1024 + 1, 0x61),
      "text/plain",
    );
    const omitted = await previewFile(
      f.files,
      "local",
      f.project.id,
      largeText.id,
    );
    assert.ok(omitted.kind === "text");
    assert.equal(omitted.text.length, 64 * 1024);
    assert.equal(omitted.omittedBytes, 1);
    const invalidText = await f.seedBuffer(
      "invalid.txt",
      Buffer.from([255]),
      "text/plain",
    );
    await assert.rejects(
      previewFile(f.files, "local", f.project.id, invalidText.id),
      status(415),
    );
    const splitText = await f.seedBuffer(
      "split.txt",
      Buffer.from("a".repeat(64 * 1024 - 1) + "あ"),
      "text/plain",
    );
    const splitPreview = await previewFile(
      f.files,
      "local",
      f.project.id,
      splitText.id,
    );
    assert.ok(splitPreview.kind === "text");
    assert.equal(splitPreview.text, "a".repeat(64 * 1024 - 1));
    assert.equal(splitPreview.omittedBytes, 3);
    for (const [width, height] of [
      [8192, 1],
      [8000, 4000],
    ]) {
      const png = await sharp({
        create: { width, height, channels: 3, background: "#ffffff" },
      })
        .png()
        .toBuffer();
      const file = await f.seedBuffer("valid.png", png, "image/png");
      const image = await previewFile(f.files, "local", f.project.id, file.id);
      assert.ok(image.kind === "image");
      const metadata = await sharp(image.bytes).metadata();
      assert.equal(metadata.width, width);
      assert.equal(metadata.height, height);
    }
    for (const [width, height] of [
      [8193, 1],
      [8000, 4001],
    ]) {
      const png = await sharp({
        create: { width, height, channels: 3, background: "#fff" },
      })
        .png()
        .toBuffer();
      const file = await f.seedBuffer("too-large.png", png, "image/png");
      await assert.rejects(
        previewFile(f.files, "local", f.project.id, file.id),
        status(413),
      );
    }
    const jpeg = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#fff" },
    })
      .jpeg()
      .toBuffer();
    const jpg = await f.seedBuffer("ok.jpg", jpeg, "image/jpeg");
    assert.equal(
      (await previewFile(f.files, "local", f.project.id, jpg.id)).kind,
      "image",
    );
    const forged = await f.seedBuffer("forged.png", jpeg, "image/png");
    await assert.rejects(
      previewFile(f.files, "local", f.project.id, forged.id),
      status(415),
    );
    const bomb = await f.seed(
      "too-many-bytes.png",
      bytes(10 * MiB + 1),
      "image/png",
    );
    await assert.rejects(
      previewFile(f.files, "local", f.project.id, bomb.id),
      status(413),
    );
    const htmlBytes = Buffer.from(
      "<script>alert('MUST NOT EXECUTE');fetch('https://foreign.invalid/leak')</script>",
    );
    const html = await f.seedBuffer("hostile.html", htmlBytes, "text/html");
    const svg = await f.seedBuffer(
      "hostile.svg",
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      ),
      "image/svg+xml",
    );
    for (const file of [html, svg])
      await assert.rejects(
        previewFile(f.files, "local", f.project.id, file.id),
        status(415),
      );
    const route = fileRoutes(f.files);
    const fixtureBrowser = await browserFixture((req) =>
      new URL(req.url).pathname === "/"
        ? Promise.resolve(
            new Response("<!doctype html><pre id=literal></pre>", {
              headers: { "Content-Type": "text/html" },
            }),
          )
        : route(req),
    );
    f.cleanup.push(() => fixtureBrowser.close());
    const page = await fixtureBrowser.browser.newPage(),
      requests: string[] = [];
    let dialogs = 0;
    page.on("request", (r) => {
      if (!r.url().startsWith(fixtureBrowser.origin)) requests.push(r.url());
    });
    page.on("dialog", (dialog) => {
      dialogs++;
      void dialog.dismiss();
    });
    await page.goto(fixtureBrowser.origin);
    const path = `/api/projects/${f.project.id}/files/${text.id}/preview`;
    await page.evaluate(async (path) => {
      const data = await (await fetch(path)).json();
      document.querySelector("#literal")!.textContent = data.text;
    }, path);
    assert.match(
      (await page.locator("#literal").textContent()) ?? "",
      /<script>/,
    );
    const downloadPath = `/api/projects/${f.project.id}/files/${html.id}/download`;
    const download = page.waitForEvent("download");
    await page.evaluate((path) => {
      const a = document.createElement("a");
      a.href = path;
      a.click();
    }, downloadPath);
    const actual = await download,
      downloaded = await actual.path();
    assert.ok(downloaded);
    assert.deepEqual(await readFile(downloaded), htmlBytes);
    await actual.delete();
    const response = await fetch(fixtureBrowser.origin + downloadPath);
    assert.equal(
      response.headers.get("Content-Type"),
      "application/octet-stream",
    );
    assert.match(
      response.headers.get("Content-Disposition") ?? "",
      /^attachment;/,
    );
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), htmlBytes);
    assert.equal(dialogs, 0);
    assert.deepEqual(requests, []);
    await unlink(f.storage.path(jpg.blobId));
    await assert.rejects(previewFile(f.files, "local", f.project.id, jpg.id));
  },
);
