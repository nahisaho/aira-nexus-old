import pg from "pg";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { Operations, Job, Terminal } from "./operations";
import type { Notebooks, NotebookRuntime } from "./notebooks";
import type { Confirmations, ConfirmedReceipt, ExecutionSnapshot } from "./confirmations";
import type { Provenance } from "./provenance";
import { captureSchema, type CapturedRun, type RunEnvironment, type RunOutput } from "./run-snapshots";
import { type Files, type FileVersion, safeFileName, MAX_FILE_BYTES, MAX_INPUT_BYTES } from "./files";
import type { Credentials } from "./credentials";
import { databaseConfig } from "./database";
import { ownedProject, projectId as validId } from "./project-scope";
import { docker, inspectOwned, stopOwned, removeOwned, type ContainerIdentity } from "./owned-containers";
import { ServiceError } from "./http";
import { RuntimeChannel, RAW_CHUNK_BYTES, decodeChunk, verifyAck, digest, type WorkerFrame } from "./transfers";

export interface RuntimeOutcome { job: Job; run: CapturedRun | null; status: number; code: string }
export interface RuntimeStatus {
  kernelEpoch: string | null;
  state: "reserved" | "creating" | "ready" | "closing" | "stopped" | "uncertain";
  container: ContainerIdentity | null;
  busy: boolean;
  activeJobId: string | null;
}
interface Row {
  kernel_epoch: string; notebook_id: string; actor: string; project_id: string;
  application_id: string; control_id: string; container_id: string | null;
  state: "creating" | "ready" | "stopped" | "uncertain";
  image_digest: string; environment: RunEnvironment | null; inputs: ExecutionSnapshot["inputs"];
  last_used: string;
}
interface Kernel { row: Row; channel?: RuntimeChannel; creation?: Promise<void>; createRequested: boolean; closed: boolean; stopping?: Promise<void> }
interface Entry { snapshot: ExecutionSnapshot; receipt: ConfirmedReceipt; task: Promise<RuntimeOutcome>; cancelled: boolean }
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
const fileSchema = z.object({ name: z.string(), size: count.max(MAX_FILE_BYTES), sha256, transferId: z.uuid() }).strict();
const identity = (row: Row): ContainerIdentity => {
  if (!row.container_id) throw new ServiceError(503, "RUNTIME_CONTAINER_ID_UNKNOWN");
  return { id: row.container_id, applicationId: row.application_id, controlId: row.control_id, resourceId: row.kernel_epoch };
};
function response<T>(schema: z.ZodType<T>, frame: unknown): T {
  const parsed = schema.safeParse(frame);
  if (!parsed.success) throw new ServiceError(503, "INVALID_RUNTIME_RESPONSE");
  return parsed.data;
}
function sameInputs(a: ExecutionSnapshot["inputs"], b: ExecutionSnapshot["inputs"]) {
  const key = (inputs: ExecutionSnapshot["inputs"]) => JSON.stringify(inputs.map(file => [file.workspaceName, file.id, file.size, file.sha256]).sort((x, y) => String(x[0]).localeCompare(String(y[0]), "en")));
  return key(a) === key(b);
}
/** @id CODE-RUN-RUNTIME @implements REQ-RUN-001 REQ-RUN-002 REQ-RUN-003 REQ-RUN-004 */
export class Runtime implements NotebookRuntime {
  private readonly pool: pg.Pool;
  private readonly now: () => number;
  private notebooks?: Notebooks;
  private confirmations?: Confirmations;
  private readonly kernels = new Map<string, Kernel>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly entries = new Map<string, Entry>();
  private readonly active = new Map<string, Entry>();
  private timer?: ReturnType<typeof setInterval>;
  private closing = false;
  private closed = false;
  private closingTask?: Promise<void>;
  constructor(
    private readonly operations: Operations,
    private readonly files: Files,
    private readonly provenance: Provenance,
    state: string,
    private readonly credentials: Credentials,
    private readonly imageDigest: string,
    options?: { now?: () => number },
  ) {
    if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new ServiceError(503, "INVALID_RUNTIME_IMAGE_DIGEST");
    this.now = options?.now ?? Date.now;
    this.pool = new pg.Pool({ ...databaseConfig(state, credentials, "application"), max: 4 });
    this.pool.on("error", () => console.error("RUNTIME_DATABASE_CONNECTION_LOST"));
  }
  async initialize(notebooks: Notebooks, confirmations: Confirmations): Promise<void> {
    if (this.closing || this.notebooks) throw new ServiceError(503, "RUNTIME_ALREADY_INITIALIZED");
    const observed = await docker(["image", "inspect", this.imageDigest, "--format", "{{.Id}}"]);
    if (observed !== this.imageDigest) throw new ServiceError(503, "RUNTIME_IMAGE_MISMATCH");
    await this.operations.write(async client => {
      if ((await client.query("SELECT 1 FROM runtime_containers WHERE state<>'stopped'")).rowCount)
        throw new ServiceError(503, "RUNTIME_RECOVERY_REQUIRED");
      await client.query("UPDATE runtime_reservations SET image_digest=$1,kernel_epoch=gen_random_uuid() WHERE image_digest<>$1", [this.imageDigest]);
      await client.query(`INSERT INTO runtime_outcomes(job_id,run_id,status,code)
        SELECT j.id,r.id,503,'RUNTIME_RESULT_UNCERTAIN' FROM jobs j LEFT JOIN runs r ON r.job_id=j.id
        WHERE j.state NOT IN ('queued','running') AND j.purpose='execution'
          AND EXISTS(SELECT 1 FROM confirmed_receipts c WHERE c.job_id=j.id AND c.receipt->>'kind'='execution')
          AND NOT EXISTS(SELECT 1 FROM runtime_outcomes o WHERE o.job_id=j.id)`);
    });
    this.notebooks = notebooks; this.confirmations = confirmations;
    this.timer = setInterval(() => { void this.expireIdle().catch(() => console.error("RUNTIME_IDLE_CLEANUP_FAILED")); }, 30000);
    this.timer.unref();
  }
  private async owned(actor: string, projectId: string, notebookId: string) {
    validId(notebookId);
    const project = await ownedProject(this.pool, actor, projectId);
    const row = await this.pool.query<{ id: string }>("SELECT n.id FROM notebooks n JOIN notebook_links l USING(id) WHERE n.id=$1 AND l.actor=$2 AND l.project_id=$3", [notebookId, actor, project.id]);
    if (row.rowCount !== 1) throw new ServiceError(404, "NOTEBOOK_NOT_FOUND");
    return { project, notebookId: row.rows[0].id };
  }
  async status(actor: string, projectId: string, notebookId: string): Promise<RuntimeStatus> {
    const owner = await this.owned(actor, projectId, notebookId);
    const result = await this.pool.query<Row & { reservation_state: string }>(`SELECT r.*,s.state AS reservation_state FROM runtime_reservations s JOIN runtime_containers r USING(kernel_epoch) WHERE s.notebook_id=$1`, [owner.notebookId]);
    const row = result.rows[0], entry = this.active.get(owner.notebookId);
    if (!row) return { kernelEpoch: null, state: "reserved", container: null, busy: Boolean(entry), activeJobId: entry?.receipt.jobId ?? null };
    const container = row.container_id ? identity(row) : null;
    if (row.state === "ready" && container && !(await inspectOwned(container)).State.Running) {
      await this.stopEpoch(owner.notebookId, row.kernel_epoch);
      return { kernelEpoch: null, state: "stopped", container: null, busy: Boolean(entry), activeJobId: entry?.receipt.jobId ?? null };
    }
    return { kernelEpoch: row.state === "ready" && row.reservation_state === "ready" ? row.kernel_epoch : null, state: row.reservation_state === "closing" ? "closing" : row.state, container, busy: Boolean(entry), activeJobId: entry?.receipt.jobId ?? null };
  }
  async epoch(actor: string, projectId: string, notebookId: string): Promise<string | null> {
    return (await this.status(actor, projectId, notebookId)).kernelEpoch;
  }
  async submit(actor: string, projectId: string, input: unknown): Promise<{ receipt: ConfirmedReceipt; admitted: boolean }> {
    if (this.closing || !this.confirmations) throw new ServiceError(503, "RUNTIME_NOT_READY");
    const result = await this.confirmations.admit(actor, projectId, "execution", input);
    if (!result.admitted) return result;
    if (result.receipt.snapshot.kind !== "execution") throw new ServiceError(503, "EXECUTION_RECEIPT_KIND_MISMATCH");
    const snapshot = result.receipt.snapshot;
    const previous = this.tails.get(snapshot.notebookId) ?? Promise.resolve();
    const task: Promise<RuntimeOutcome> = previous.then(() => this.process(entry));
    const entry: Entry = { snapshot, receipt: result.receipt, cancelled: false, task };
    this.entries.set(result.receipt.jobId, entry);
    const tail = task.then(() => {}, () => { console.error("RUNTIME_QUEUE_STEP_FAILED"); });
    this.tails.set(snapshot.notebookId, tail);
    void tail.then(() => {
      this.entries.delete(result.receipt.jobId);
      if (this.tails.get(snapshot.notebookId) === tail) this.tails.delete(snapshot.notebookId);
    });
    return result;
  }
  private async stored(actor: string, projectId: string, jobId: string): Promise<RuntimeOutcome> {
    const project = await ownedProject(this.pool, actor, projectId);
    const job = await this.operations.get(actor, jobId);
    if (job.project_id !== project.id) throw new ServiceError(404, "JOB_NOT_FOUND");
    const value = (await this.pool.query<{ run_id: string | null; status: number; code: string }>("SELECT * FROM runtime_outcomes WHERE job_id=$1", [job.id])).rows[0];
    if (!value) throw new ServiceError(409, "RUNTIME_OUTCOME_NOT_AVAILABLE");
    return { job, run: value.run_id ? await this.provenance.get(actor, project.id, value.run_id) : null, status: value.status, code: value.code };
  }
  async wait(actor: string, projectId: string, jobId: string): Promise<RuntimeOutcome> {
    validId(jobId);
    const project = await ownedProject(this.pool, actor, projectId);
    const job = await this.operations.get(actor, jobId);
    if (job.project_id !== project.id) throw new ServiceError(404, "JOB_NOT_FOUND");
    const entry = this.entries.get(job.id);
    return entry ? entry.task : this.stored(actor, project.id, job.id);
  }
  async execute(actor: string, projectId: string, input: unknown): Promise<RuntimeOutcome> {
    const admitted = await this.submit(actor, projectId, input);
    const outcome = await this.wait(actor, projectId, admitted.receipt.jobId);
    if (outcome.status !== 200) throw new ServiceError(outcome.status, outcome.code);
    return outcome;
  }
  private async record(snapshot: ExecutionSnapshot, jobId: string, run: CapturedRun | null, status: number, code: string) {
    await this.operations.write(async client => {
      if (code === "RUNTIME_ARTIFACT_CLEANUP_UNCERTAIN" || (
        await client.query("SELECT 1 FROM runtime_containers WHERE kernel_epoch=$1 AND state='uncertain'", [snapshot.kernelEpoch])
      ).rowCount)
        await client.query("UPDATE jobs SET cleanup='unknown' WHERE id=$1", [jobId]);
      const prior = await client.query<{ run_id: string | null; status: number; code: string }>("SELECT * FROM runtime_outcomes WHERE job_id=$1", [jobId]);
      if (prior.rowCount) {
        const row = prior.rows[0];
        if (row.run_id !== (run?.id ?? null) || row.status !== status || row.code !== code) throw new ServiceError(409, "RUNTIME_OUTCOME_ALREADY_FINAL");
      } else await client.query("INSERT INTO runtime_outcomes(job_id,run_id,status,code) VALUES($1,$2,$3,$4)", [jobId, run?.id ?? null, status, code]);
    });
    return this.stored(snapshot.actor, snapshot.projectId, jobId);
  }
  private async process(entry: Entry): Promise<RuntimeOutcome> {
    const s = entry.snapshot, id = entry.receipt.jobId;
    let job = await this.operations.get(s.actor, id);
    if (!["queued", "running"].includes(job.state)) return this.stored(s.actor, s.projectId, id);
    this.active.set(s.notebookId, entry);
    let kernel: Kernel | undefined, run: CapturedRun | null = null;
    let prepared: FileVersion[] = [], publication = false, dispatched = false;
    try {
      if (!this.notebooks) throw new ServiceError(503, "RUNTIME_NOT_READY");
      if (entry.cancelled || this.closing) throw new ServiceError(409, "RUNTIME_INTERRUPTED");
      const current = await this.notebooks.source(s.actor, s.projectId, s.notebookId, s.cellId);
      if (current.revision !== s.revision || current.source !== s.source || current.language !== s.language || current.sharing.length !== s.sharing.length || current.sharing.some((value, i) => value.name !== s.sharing[i].name || value.direction !== s.sharing[i].direction || value.family !== s.sharing[i].family))
        throw new ServiceError(409, "STALE_EXECUTION_SOURCE");
      kernel = await this.ensure(s);
      if (entry.cancelled || this.closing || kernel.closed) throw new ServiceError(409, "RUNTIME_INTERRUPTED");
      run = await this.provenance.capture(s.actor, s.projectId, this.capture(s, id, kernel.row.environment));
      await this.operations.write(async client => {
        const eligible = await client.query("SELECT id FROM jobs WHERE id=$1 AND actor=$2 AND state='queued' AND NOT cancel_requested FOR UPDATE", [id, s.actor]);
        if (eligible.rowCount !== 1) throw new ServiceError(409, "JOB_NOT_DISPATCHABLE");
        await client.query("INSERT INTO runtime_job_bindings(job_id,kernel_epoch) VALUES($1,$2)", [id, s.kernelEpoch]);
      });
      await this.operations.dispatch(s.actor, id); dispatched = true;
      if (!kernel.channel) throw new ServiceError(503, "RUNTIME_CHANNEL_UNAVAILABLE");
      const outputs = await kernel.channel.execute(s.source, s.language, s.sharing, () => this.operations.observeStarted(s.actor, id));
      prepared = await this.harvest(kernel, s.actor, s.projectId);
      publication = true;
      await this.notebooks.completeRun(s.actor, s.projectId, s.notebookId, run.id, { status: outputs.some(output => output.output_type === "error") ? "failed" : "completed", outputs, artifacts: prepared });
      run = await this.provenance.get(s.actor, s.projectId, run.id);
      await this.operations.write(client => client.query("UPDATE runtime_containers SET last_used=to_timestamp($2/1000.0) WHERE kernel_epoch=$1", [s.kernelEpoch, this.now()]));
      return await this.record(s, id, run, 200, run.status === "failed" ? "CELL_ERROR" : "OK");
    } catch (error) {
      if (!(error instanceof ServiceError)) console.error("RUNTIME_EXECUTION_FAILED");
      let failure = error instanceof ServiceError ? error :
        new ServiceError(503, error instanceof AggregateError && error.message === "RUNTIME_ARTIFACT_CLEANUP_UNCERTAIN" ? "RUNTIME_ARTIFACT_CLEANUP_UNCERTAIN" : "RUNTIME_EXECUTION_FAILED");
      if (kernel && (dispatched || failure.status >= 500 || failure.status === 413 || entry.cancelled || this.closing)) {
        try { await this.stopEpoch(s.notebookId, s.kernelEpoch); }
        catch { console.error("RUNTIME_CLEANUP_UNCERTAIN"); failure = new ServiceError(503, "RUNTIME_CLEANUP_UNCERTAIN"); }
      }
      if (!publication) {
        const cleanup = await Promise.allSettled(prepared.map(file => this.files.discardPrepared(file)));
        if (cleanup.some(item => item.status === "rejected")) {
          console.error("RUNTIME_ARTIFACT_CLEANUP_UNCERTAIN");
          failure = new ServiceError(503, "RUNTIME_ARTIFACT_CLEANUP_UNCERTAIN");
        }
      }
      job = await this.operations.get(s.actor, id);
      if (job.state === "cancelled") return await this.stored(s.actor, s.projectId, id);
      if (["queued", "running"].includes(job.state)) {
        const terminal: Terminal = job.cancel_requested ? "cancelled" : this.closing ? "interrupted" : failure.status === 504 ? "timeout" : "failed";
        const outputs: RunOutput[] = [{ output_type: "error", ename: "RuntimeError", evalue: failure.code, traceback: [] }];
        if (run && this.notebooks) {
          try { await this.notebooks.completeRun(s.actor, s.projectId, s.notebookId, run.id, { status: terminal, outputs, artifacts: [] }); }
          catch (projection) {
            if (!(projection instanceof ServiceError && projection.code === "STALE_RUN_PROJECTION")) {
              console.error("RUNTIME_TERMINAL_PROJECTION_FAILED");
              failure = new ServiceError(503, "RUNTIME_TERMINAL_PROJECTION_FAILED");
              const current = await this.operations.get(s.actor, id);
              if (["queued", "running"].includes(current.state)) {
                try { await this.provenance.finish(s.actor, s.projectId, run.id, { status: terminal, outputs, artifacts: [] }, s.notebookId); }
                catch {
                  console.error("RUNTIME_TERMINAL_RECORD_UNCERTAIN");
                  failure = new ServiceError(503, "RUNTIME_RESULT_UNCERTAIN");
                  const latest = await this.operations.get(s.actor, id);
                  if (["queued", "running"].includes(latest.state)) await this.operations.finish(s.actor, id, terminal);
                }
              }
            }
          }
        } else await this.operations.finish(s.actor, id, terminal);
        if (job.cancel_requested) failure = new ServiceError(409, "EXECUTION_CANCELLED");
      }
      return await this.record(s, id, run, failure.status, failure.code);
    } finally { if (this.active.get(s.notebookId) === entry) this.active.delete(s.notebookId); }
  }
  private capture(s: ExecutionSnapshot, jobId: string, environment: RunEnvironment | null) {
    return { jobId, notebookId: s.notebookId, cellId: s.cellId, revision: s.revision, source: s.source, language: s.language, sharing: s.sharing, inputs: s.inputs.map(file => ({ id: file.id, name: file.workspaceName })), kernelEpoch: s.kernelEpoch, environment };
  }
  private async ensure(s: ExecutionSnapshot): Promise<Kernel> {
    if (this.closing) throw new ServiceError(503, "RUNTIME_NOT_READY");
    const row = await this.operations.write(async client => {
      if (this.closing) throw new ServiceError(503, "RUNTIME_NOT_READY");
      const project = await ownedProject(client, s.actor, s.projectId, true);
      if (project.status !== "active") throw new ServiceError(409, "PROJECT_ARCHIVED");
      const reservation = (await client.query<{ kernel_epoch: string; image_digest: string; state: string; current: boolean }>("SELECT *,writer_epoch=(SELECT epoch FROM writer_control) AS current FROM runtime_reservations WHERE notebook_id=$1 FOR UPDATE", [s.notebookId])).rows[0];
      if (!reservation || !reservation.current || reservation.kernel_epoch !== s.kernelEpoch || reservation.image_digest !== this.imageDigest || !["reserved", "starting", "ready"].includes(reservation.state))
        throw new ServiceError(409, "RUNTIME_IDENTITY_CHANGED");
      const existing = (await client.query<Row>("SELECT * FROM runtime_containers WHERE kernel_epoch=$1", [s.kernelEpoch])).rows[0];
      if (existing) {
        if (!sameInputs(existing.inputs, s.inputs)) throw new ServiceError(409, "INPUT_SELECTION_REQUIRES_RESTART");
        if (existing.state !== "ready") throw new ServiceError(409, "RUNTIME_NOT_READY");
        return existing;
      }
      if (Number((await client.query("SELECT count(*) FROM runtime_containers WHERE state<>'stopped'")).rows[0].count) >= 2)
        throw new ServiceError(503, "RUNTIME_CAPACITY_EXHAUSTED");
      await client.query("UPDATE runtime_reservations SET state='starting' WHERE notebook_id=$1", [s.notebookId]);
      return (await client.query<Row>(`INSERT INTO runtime_containers(kernel_epoch,notebook_id,actor,project_id,application_id,control_id,image_digest,state,inputs,writer_epoch)
        SELECT $1,$2,$3,$4,$5,$6,$7,'creating',$8::jsonb,epoch FROM writer_control RETURNING *`,
      [s.kernelEpoch, s.notebookId, s.actor, s.projectId, this.credentials.applicationId, this.credentials.controlId, this.imageDigest, JSON.stringify(s.inputs)])).rows[0];
    });
    if (row.state === "ready") {
      const kernel = this.kernels.get(row.kernel_epoch);
      if (!kernel?.channel || kernel.closed) throw new ServiceError(503, "RUNTIME_CHANNEL_UNAVAILABLE");
      return kernel;
    }
    const kernel: Kernel = { row, createRequested: false, closed: false }; this.kernels.set(row.kernel_epoch, kernel);
    kernel.creation = (async () => {
      await this.operations.write(async client => {
        const reservation = await client.query("SELECT notebook_id FROM runtime_reservations WHERE notebook_id=$1 AND kernel_epoch=$2 AND state='starting'", [s.notebookId, s.kernelEpoch]);
        if (reservation.rowCount !== 1 || kernel.closed || this.closing) throw new ServiceError(409, "RUNTIME_INTERRUPTED");
      });
      kernel.createRequested = true;
      const id = await docker(["create", "-i", "--user", "1000:1000", "--network", "none", "--read-only",
        "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--cpus", "1", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "128",
        "--tmpfs", "/tmp:rw,nosuid,noexec,size=268435456,mode=1777",
        "--tmpfs", "/workspace:rw,nosuid,noexec,size=536870912,uid=1000,gid=1000,mode=0700",
        "--label", `aira.application=${row.application_id}`, "--label", `aira.control=${row.control_id}`, "--label", `aira.resource=${row.kernel_epoch}`, this.imageDigest]);
      if (!/^[a-f0-9]{64}$/.test(id)) throw new ServiceError(503, "RUNTIME_CONTAINER_ID_UNKNOWN");
      kernel.row.container_id = id;
      await this.operations.write(client => client.query("UPDATE runtime_containers SET container_id=$2 WHERE kernel_epoch=$1", [row.kernel_epoch, id]));
      const observed = await inspectOwned(identity(kernel.row));
      if (observed.Image !== this.imageDigest) throw new ServiceError(503, "RUNTIME_IMAGE_MISMATCH");
      const host = observed.HostConfig;
      const tmp = new Set((host.Tmpfs["/tmp"] ?? "").split(","));
      const workspace = new Set((host.Tmpfs["/workspace"] ?? "").split(","));
      if (observed.Config.User !== "1000:1000" || host.NetworkMode !== "none" || !host.ReadonlyRootfs ||
          host.Memory !== 2 * 1024 ** 3 || host.NanoCpus !== 1000000000 || host.PidsLimit !== 128 ||
          host.Privileged || host.CapDrop.length !== 1 || host.CapDrop[0] !== "ALL" || host.CapAdd?.length ||
          host.Devices.length || host.DeviceRequests?.length || Object.keys(host.PortBindings ?? {}).length ||
          !host.SecurityOpt.some(value => value === "no-new-privileges" || value === "no-new-privileges:true") ||
          !["nosuid", "noexec", "size=268435456"].every(value => tmp.has(value)) ||
          !["nosuid", "noexec", "size=536870912", "uid=1000", "gid=1000"].every(value => workspace.has(value)) ||
          Object.keys(host.Tmpfs).length !== 2 || observed.Mounts.some(mount => mount.Type !== "tmpfs" || !["/tmp", "/workspace"].includes(mount.Destination)))
        throw new ServiceError(503, "RUNTIME_ISOLATION_MISMATCH");
    })();
    try {
      await kernel.creation;
      if (kernel.closed || this.closing) throw new ServiceError(409, "RUNTIME_INTERRUPTED");
      const channel = new RuntimeChannel(identity(kernel.row).id); kernel.channel = channel;
      await channel.ready();
      const environment = await this.phase(kernel, "STAGING_TIMEOUT", async request => {
        response(z.object({ id: z.uuid(), kind: z.literal("ack") }).strict(), await request({ kind: "stage-begin", files: s.inputs.map(file => ({ id: file.id, name: file.workspaceName, size: file.size, sha256: file.sha256 })) }));
        for (const file of s.inputs) {
          const version = await this.files.get(s.actor, s.projectId, file.id);
          if (version.sha256 !== file.sha256 || version.size !== file.size) throw new ServiceError(409, "INPUT_VERSION_CHANGED");
          const transferId = randomUUID();
          this.ack(await request({ kind: "file-begin", transferId, fileId: file.id, name: file.workspaceName, size: file.size, sha256: file.sha256 }), { transferId, offset: 0, sha256: digest(Buffer.alloc(0)) });
          let offset = 0; const hashed = createHash("sha256");
          for await (const source of this.files.storage.read(version.blobId)) {
            for (let first = 0; first < source.length; first += RAW_CHUNK_BYTES) {
              const chunk = source.subarray(first, first + RAW_CHUNK_BYTES), sha256 = digest(chunk);
              this.ack(await request({ kind: "file-chunk", transferId, offset, data: chunk.toString("base64"), sha256 }), { transferId, offset: offset + chunk.length, sha256 });
              offset += chunk.length; hashed.update(chunk);
            }
          }
          if (offset !== file.size || hashed.digest("hex") !== file.sha256) throw new ServiceError(503, "INPUT_INTEGRITY_ERROR");
          this.ack(await request({ kind: "file-end", transferId, size: offset, sha256: file.sha256 }), { transferId, offset, sha256: file.sha256 });
        }
        const ready = response(z.object({ id: z.uuid(), kind: z.literal("ready"), environment: captureSchema.shape.environment.unwrap() }).strict(), await request({ kind: "initialize", imageDigest: this.imageDigest }, 60000));
        if (ready.environment.imageDigest !== this.imageDigest || !ready.environment.python || !ready.environment.r) throw new ServiceError(503, "RUNTIME_ENVIRONMENT_UNOBSERVED");
        return ready.environment;
      });
      if (kernel.closed) throw new ServiceError(409, "RUNTIME_INTERRUPTED");
      kernel.row.environment = environment; kernel.row.state = "ready";
      await this.operations.write(async client => {
        const state = await client.query("UPDATE runtime_reservations SET state='ready' WHERE notebook_id=$1 AND kernel_epoch=$2 AND state='starting' RETURNING notebook_id", [s.notebookId, s.kernelEpoch]);
        if (state.rowCount !== 1) throw new ServiceError(409, "RUNTIME_INTERRUPTED");
        await client.query("UPDATE runtime_containers SET state='ready',environment=$2::jsonb,last_used=to_timestamp($3/1000.0) WHERE kernel_epoch=$1", [s.kernelEpoch, JSON.stringify(environment), this.now()]);
      });
      return kernel;
    } catch (error) {
      if (kernel.row.container_id) await this.stopEpoch(s.notebookId, s.kernelEpoch);
      else if (kernel.createRequested) await this.operations.write(async client => {
        await client.query("UPDATE runtime_containers SET state='uncertain' WHERE kernel_epoch=$1", [s.kernelEpoch]);
        await client.query("UPDATE runtime_reservations SET state='uncertain' WHERE notebook_id=$1 AND kernel_epoch=$2", [s.notebookId, s.kernelEpoch]);
      });
      else await this.stopEpoch(s.notebookId, s.kernelEpoch);
      throw error;
    }
  }
  private ack(frame: WorkerFrame, expected: { transferId: string; offset: number; sha256: string }) {
    const value = response(z.object({ id: z.uuid(), kind: z.literal("ack"), transferId: z.uuid(), offset: count, sha256 }).strict(), frame);
    verifyAck({ transferId: value.transferId, offset: value.offset, sha256: value.sha256 }, expected);
  }
  private async phase<T>(kernel: Kernel, code: string, body: (request: (input: WorkerFrame, timeoutMs?: number) => Promise<WorkerFrame>) => Promise<T>): Promise<T> {
    if (!kernel.channel) throw new ServiceError(503, "RUNTIME_CHANNEL_UNAVAILABLE");
    const channel = kernel.channel, deadline = performance.now() + 120000;
    const timer = setTimeout(() => channel.abort(new ServiceError(504, code)), 120000);
    try {
      return await body(async (input, timeoutMs = 10000) => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new ServiceError(504, code);
        const frame = await channel.request(input, Math.min(timeoutMs, remaining));
        if (performance.now() > deadline) throw new ServiceError(504, code);
        return frame;
      });
    } finally { clearTimeout(timer); }
  }
  private async harvest(kernel: Kernel, actor: string, projectId: string): Promise<FileVersion[]> {
    const prepared: FileVersion[] = [];
    try {
      return await this.phase(kernel, "HARVEST_TIMEOUT", async request => {
        const manifest = response(z.object({ id: z.uuid(), kind: z.literal("manifest"), files: z.array(fileSchema) }).strict(), await request({ kind: "harvest-list" }));
        const names = new Set<string>(), transfers = new Set<string>(); let total = 0;
        for (const file of manifest.files) {
          safeFileName(file.name); total += file.size;
          if (names.has(file.name) || transfers.has(file.transferId) || total > MAX_INPUT_BYTES) throw new ServiceError(413, "INVALID_OUTPUT_MANIFEST");
          names.add(file.name); transfers.add(file.transferId);
          this.ack(await request({ kind: "harvest-open", transferId: file.transferId }), { transferId: file.transferId, offset: 0, sha256: digest(Buffer.alloc(0)) });
          const body = async function* () {
            let offset = 0; const hashed = createHash("sha256");
            while (offset < file.size) {
              const frame = response(z.object({ id: z.uuid(), kind: z.literal("chunk"), transferId: z.uuid(), offset: count, data: z.string(), sha256 }).strict(), await request({ kind: "harvest-read", transferId: file.transferId, offset }));
              const chunk = decodeChunk({ transferId: frame.transferId, offset: frame.offset, data: frame.data, sha256: frame.sha256 }, { transferId: file.transferId, offset });
              if (!chunk.length || offset + chunk.length > file.size) throw new ServiceError(503, "OUTPUT_LENGTH_MISMATCH");
              hashed.update(chunk); offset += chunk.length;
              yield chunk;
              const ack = await request({ kind: "harvest-ack", transferId: file.transferId, offset, sha256: frame.sha256 });
              const checked = response(z.object({ id: z.uuid(), kind: z.literal("ack"), transferId: z.uuid(), offset: count, sha256 }).strict(), ack);
              verifyAck({ transferId: checked.transferId, offset: checked.offset, sha256: checked.sha256 }, { transferId: file.transferId, offset, sha256: frame.sha256 });
            }
            const end = response(z.object({ id: z.uuid(), kind: z.literal("file-end"), transferId: z.uuid(), size: count, sha256 }).strict(), await request({ kind: "harvest-end", transferId: file.transferId }));
            if (end.transferId !== file.transferId || end.size !== file.size || end.sha256 !== file.sha256 || hashed.digest("hex") !== file.sha256) throw new ServiceError(503, "OUTPUT_INTEGRITY_ERROR");
          };
          const output = await this.files.prepare(actor, projectId, file.name, "application/octet-stream", body());
          prepared.push(output);
          if (output.size !== file.size || output.sha256 !== file.sha256) throw new ServiceError(503, "OUTPUT_INTEGRITY_ERROR");
        }
        return prepared;
      });
    } catch (error) {
      const cleanup = await Promise.allSettled(prepared.map(file => this.files.discardPrepared(file)));
      const failed = cleanup.filter(item => item.status === "rejected").map(item => item.reason);
      if (failed.length) throw new AggregateError([error, ...failed], "RUNTIME_ARTIFACT_CLEANUP_UNCERTAIN");
      throw error;
    }
  }
  private async stopEpoch(notebookId: string, epoch: string): Promise<void> {
    const kernel = this.kernels.get(epoch);
    if (kernel?.stopping) return kernel.stopping;
    const stop = async () => {
      if (kernel) {
        kernel.closed = true;
        if (kernel.creation) {
          try { await kernel.creation; }
          catch (error) { if (kernel.createRequested && !kernel.row.container_id) throw error; }
        }
        kernel.channel?.close();
      }
      const row = kernel?.row ?? (await this.pool.query<Row>("SELECT * FROM runtime_containers WHERE notebook_id=$1 AND kernel_epoch=$2", [notebookId, epoch])).rows[0];
      if (row) {
        if (row.application_id !== this.credentials.applicationId || row.control_id !== this.credentials.controlId) throw new ServiceError(503, "RUNTIME_OWNERSHIP_UNCERTAIN");
        if (row.container_id) await stopOwned(identity(row));
        else if (row.state !== "stopped" && (!kernel || kernel.createRequested)) throw new ServiceError(503, "RUNTIME_CONTAINER_ID_UNKNOWN");
      }
      await this.operations.write(async client => {
        if (row) await client.query("UPDATE runtime_containers SET state='stopped' WHERE kernel_epoch=$1", [epoch]);
        await client.query("UPDATE runtime_reservations SET kernel_epoch=gen_random_uuid(),state='reserved',writer_epoch=(SELECT epoch FROM writer_control) WHERE notebook_id=$1 AND kernel_epoch=$2", [notebookId, epoch]);
      });
      this.kernels.delete(epoch);
    };
    const stopping = stop().catch(async error => {
      try {
        await this.operations.write(async client => {
          await client.query("UPDATE runtime_containers SET state='uncertain' WHERE notebook_id=$1 AND kernel_epoch=$2 AND state<>'stopped'", [notebookId, epoch]);
          await client.query("UPDATE runtime_reservations SET state='uncertain' WHERE notebook_id=$1 AND kernel_epoch=$2", [notebookId, epoch]);
        });
      } catch (metadata) { throw new AggregateError([error, metadata], "RUNTIME_STOP_METADATA_UNCERTAIN"); }
      throw error;
    });
    if (kernel) {
      kernel.stopping = stopping;
      void stopping.then(() => {}, () => { if (kernel.stopping === stopping) kernel.stopping = undefined; });
    }
    return stopping;
  }
  async invalidate(actor: string, projectId: string, notebookId: string, epoch: string): Promise<void> {
    const owner = await this.owned(actor, projectId, notebookId); validId(epoch);
    await this.stopEpoch(owner.notebookId, epoch.toLowerCase());
  }
  async restart(actor: string, projectId: string, notebookId: string, epoch: string): Promise<void> {
    const owner = await this.owned(actor, projectId, notebookId); validId(epoch);
    await this.operations.write(async client => {
      const value = await client.query("UPDATE runtime_reservations SET state='closing' WHERE notebook_id=$1 AND kernel_epoch=$2 RETURNING notebook_id", [owner.notebookId, epoch]);
      if (value.rowCount !== 1) throw new ServiceError(409, "RUNTIME_IDENTITY_CHANGED");
    });
    await this.stopEpoch(owner.notebookId, epoch.toLowerCase());
  }
  async cancel(actor: string, projectId: string, jobId: string): Promise<Job> {
    const project = await ownedProject(this.pool, actor, projectId);
    const job = await this.operations.get(actor, jobId);
    if (job.project_id !== project.id) throw new ServiceError(404, "JOB_NOT_FOUND");
    await this.operations.requestCancel(actor, job.id);
    const entry = this.entries.get(job.id);
    if (entry) {
      entry.cancelled = true;
      if (this.active.get(entry.snapshot.notebookId) === entry) {
        await this.stopEpoch(entry.snapshot.notebookId, entry.snapshot.kernelEpoch);
        return (await entry.task).job;
      }
      return this.operations.write(async client => {
        const current = (await client.query<Job>("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [job.id])).rows[0];
        if (current.state === "cancelled") return current;
        const terminal = await this.operations.finishInTransaction(client, actor, job.id, "cancelled");
        await client.query("INSERT INTO runtime_outcomes(job_id,run_id,status,code) VALUES($1,NULL,409,'EXECUTION_CANCELLED')", [job.id]);
        return terminal;
      });
    }
    throw new ServiceError(503, "RUNTIME_JOB_NOT_ATTACHED");
  }
  async expireIdle(): Promise<void> {
    if (this.closing) return;
    const rows = await this.pool.query<Row>("SELECT * FROM runtime_containers WHERE state='ready'");
    for (const row of rows.rows) if (!this.active.has(row.notebook_id) && this.now() - Date.parse(row.last_used) >= 600000) {
      const expired = await this.operations.write(async client => {
        if (this.active.has(row.notebook_id)) return false;
        const result = await client.query("UPDATE runtime_reservations SET state='closing' WHERE notebook_id=$1 AND kernel_epoch=$2 AND state='ready' RETURNING notebook_id", [row.notebook_id, row.kernel_epoch]);
        if (result.rowCount !== 1) throw new ServiceError(409, "RUNTIME_IDENTITY_CHANGED");
        return true;
      });
      if (expired) await this.stopEpoch(row.notebook_id, row.kernel_epoch);
    }
  }
  async close() {
    if (this.closed) return;
    if (this.closingTask) return this.closingTask;
    const task = this.cleanup();
    this.closingTask = task;
    void task.then(() => {}, () => { if (!this.closed && this.closingTask === task) this.closingTask = undefined; });
    return task;
  }
  private async cleanup() {
    this.closing = true; clearInterval(this.timer);
    const rows = await this.pool.query<Row>("SELECT * FROM runtime_containers WHERE application_id=$1 AND control_id=$2", [this.credentials.applicationId, this.credentials.controlId]);
    const attempts = await Promise.allSettled(rows.rows.filter(row => row.state !== "stopped").map(row => this.stopEpoch(row.notebook_id, row.kernel_epoch)));
    const failures: unknown[] = attempts.filter(item => item.status === "rejected").map(item => item.reason);
    const drained = await Promise.allSettled([...this.entries.values()].map(entry => entry.task));
    if (drained.some(result => result.status === "rejected")) console.error("RUNTIME_DRAINED_WITH_FAILED_JOBS");
    const stopped = await this.pool.query<Row>("SELECT * FROM runtime_containers WHERE application_id=$1 AND control_id=$2", [this.credentials.applicationId, this.credentials.controlId]);
    for (const row of stopped.rows) {
      try {
        if (!row.container_id) {
          if (row.state === "stopped") continue;
          throw new ServiceError(503, "RUNTIME_CLEANUP_UNCERTAIN");
        }
        await removeOwned(identity(row));
        await this.operations.write(client => client.query("UPDATE runtime_containers SET state='stopped',container_id=NULL WHERE kernel_epoch=$1", [row.kernel_epoch]));
      } catch (error) {
        failures.push(error);
      }
    }
    const remaining = await this.pool.query("SELECT 1 FROM runtime_containers WHERE application_id=$1 AND control_id=$2 AND (state<>'stopped' OR container_id IS NOT NULL)", [this.credentials.applicationId, this.credentials.controlId]);
    if (!remaining.rowCount) { this.closed = true; await this.pool.end(); }
    if (failures.length) throw new AggregateError(failures, "RUNTIME_CLEANUP_UNCERTAIN");
    if (!this.closed) throw new ServiceError(503, "RUNTIME_CLEANUP_UNCERTAIN");
  }
}
