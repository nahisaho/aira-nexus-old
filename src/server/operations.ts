import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { ServiceError } from "./http";
import type { Credentials } from "./credentials";
import { databaseConfig } from "./database";
import { ownedProject, projectId as validateProjectId } from "./project-scope";
import {
  inspectOwned,
  stopOwned,
  type ContainerIdentity,
} from "./owned-containers";

export type Purpose = "chat" | "execution" | "advisory";
export type JobPurpose = Purpose | "check";
export type Terminal =
  "completed" | "failed" | "timeout" | "cancelled" | "interrupted";
export interface Job {
  id: string;
  actor: string;
  request_id: string;
  purpose: JobPurpose;
  fingerprint: string;
  epoch: string;
  state: "queued" | "running" | Terminal;
  started: "unknown" | "observed" | "not-started";
  cleanup: "unknown" | "verified";
  cancel_requested: boolean;
  project_id: string | null;
}
const intentFields = {
  actor: z.string().min(1).max(120),
  requestId: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
};
const grantIntent = z.object({
  ...intentFields,
  purpose: z.enum(["chat", "execution", "advisory"]),
  grantId: z.uuid(),
});
const intent = z.discriminatedUnion("purpose", [
  grantIntent,
  z
    .object({
      ...intentFields,
      purpose: z.literal("check"),
      grantId: z.never().optional(),
    })
    .strict(),
]);

/** @id CODE-OPS-LIFECYCLE @implements REQ-OPS-001 REQ-OPS-002 REQ-OPS-003 */
export class Operations {
  private readonly pool: pg.Pool;
  private readonly lease: pg.Client;
  private epoch: string | null = null;
  private lost = false;
  private usable = false;
  private closed = false;
  private stopping = false;
  private tail = Promise.resolve();
  private transactionOpen = false;

  constructor(
    private readonly state: string,
    private readonly credentials: Credentials,
  ) {
    const config = databaseConfig(state, credentials, "application");
    this.pool = new pg.Pool({ ...config, max: 4 });
    this.lease = new pg.Client(config);
    this.lease.on("error", () => {
      this.lost = true;
      this.usable = false;
    });
    this.lease.on("end", () => {
      this.lost = true;
      this.usable = false;
    });
    this.pool.on("error", () => {
      this.lost = true;
      this.usable = false;
      console.error("OPERATION_DATABASE_CONNECTION_LOST");
    });
  }

  async acquire() {
    await this.lease.connect();
    const locked = (
      await this.lease.query("SELECT pg_try_advisory_lock(918273645) AS locked")
    ).rows[0].locked;
    if (!locked) throw new ServiceError(503, "WRITER_ALREADY_ACTIVE");
    await this.lease.query("BEGIN");
    try {
      const value = await this.lease.query(
        `
        UPDATE writer_control SET epoch=epoch+1, backend_pid=pg_backend_pid(),
          backend_start=(SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()),
          application_id=$1, control_id=$2, cleanup_uncertain=true
        WHERE singleton RETURNING epoch`,
        [this.credentials.applicationId, this.credentials.controlId],
      );
      if (value.rowCount !== 1)
        throw new ServiceError(503, "WRITER_CONTROL_MISSING");
      this.epoch = value.rows[0].epoch;
      await this.lease.query("COMMIT");
    } catch (error) {
      await this.lease.query("ROLLBACK");
      throw error;
    }
    await this.recover();
  }

  private async transaction<T>(
    run: (client: pg.Client) => Promise<T>,
    recovery = false,
  ): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    // Mutations use the lock-owning connection: losing the lease also aborts COMMIT.
    const client = this.lease;
    let began = false;
    try {
      if (
        this.closed ||
        this.lost ||
        this.epoch === null ||
        (!recovery && (this.stopping || !this.usable))
      ) {
        throw new ServiceError(503, "WRITER_LEASE_UNAVAILABLE");
      }
      await client.query("BEGIN");
      began = true;
      this.transactionOpen = true;
      const fence = await client.query(`
        SELECT epoch, cleanup_uncertain,
          EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
            WHERE l.locktype='advisory' AND l.granted AND l.classid=0 AND l.objid=918273645
              AND l.objsubid=1 AND l.pid=w.backend_pid AND a.backend_start=w.backend_start) AS held
        FROM writer_control w WHERE singleton FOR UPDATE`);
      const row = fence.rows[0];
      if (
        this.lost ||
        !row ||
        row.epoch !== this.epoch ||
        !row.held ||
        (row.cleanup_uncertain && !recovery)
      ) {
        this.lost = true;
        this.usable = false;
        throw new ServiceError(503, "WRITER_FENCE_REJECTED");
      }
      const result = await run(client);
      // Recheck the live lock immediately before commit, including connection loss during work.
      const held = await client.query(
        `
        SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
          JOIN writer_control w ON w.backend_pid=l.pid AND w.backend_start=a.backend_start
          WHERE l.locktype='advisory' AND l.granted AND l.classid=0 AND l.objid=918273645
            AND l.objsubid=1 AND w.epoch=$1) AS held`,
        [this.epoch],
      );
      if (this.lost || !held.rows[0].held) {
        this.lost = true;
        this.usable = false;
        throw new ServiceError(503, "WRITER_FENCE_REJECTED");
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "OPERATION_ROLLBACK_FAILED",
          );
        }
      }
      throw error;
    } finally {
      this.transactionOpen = false;
      release();
    }
  }

  private async recover() {
    // Lifecycle recovery must survive a later failure to prove container ownership.
    await this.transaction(async (client) => {
      await client.query(`UPDATE jobs SET state='interrupted', cleanup='unknown'
        WHERE state IN ('queued','running')`);
    }, true);
    await this.transaction(async (client) => {
      const containers =
        await client.query(`SELECT id, application_id, control_id, resource_id
        FROM operation_containers WHERE NOT stopped`);
      for (const row of containers.rows) {
        if (
          row.application_id !== this.credentials.applicationId ||
          row.control_id !== this.credentials.controlId
        ) {
          throw new ServiceError(503, "RESTORED_CONTAINER_IDENTITY_INERT");
        }
        await stopOwned({
          id: row.id,
          applicationId: row.application_id,
          controlId: row.control_id,
          resourceId: row.resource_id,
        });
        await client.query(
          "UPDATE operation_containers SET stopped=true WHERE id=$1",
          [row.id],
        );
      }
      const runtimes = await client.query(
        "SELECT * FROM runtime_containers WHERE state<>'stopped'",
      );
      for (const row of runtimes.rows) {
        if (
          row.application_id !== this.credentials.applicationId ||
          row.control_id !== this.credentials.controlId ||
          !row.container_id
        )
          throw new ServiceError(503, "RUNTIME_RECOVERY_OWNERSHIP_UNCERTAIN");
        await stopOwned({
          id: row.container_id,
          applicationId: row.application_id,
          controlId: row.control_id,
          resourceId: row.kernel_epoch,
        });
        await client.query(
          "UPDATE runtime_containers SET state='stopped' WHERE kernel_epoch=$1",
          [row.kernel_epoch],
        );
      }
      await client.query(`UPDATE jobs j SET cleanup='verified'
        WHERE j.state='interrupted' AND EXISTS(
          SELECT 1 FROM runtime_job_bindings b JOIN runtime_containers r USING(kernel_epoch)
          WHERE b.job_id=j.id AND r.state='stopped')`);
      await client.query(
        "UPDATE runtime_reservations SET kernel_epoch=gen_random_uuid(),writer_epoch=$1,state='reserved'",
        [this.epoch],
      );
      await client.query(`UPDATE jobs j SET cleanup='verified'
        WHERE j.state='interrupted'
          AND EXISTS(SELECT 1 FROM operation_containers c WHERE c.job_id=j.id)
          AND NOT EXISTS(SELECT 1 FROM operation_containers c WHERE c.job_id=j.id AND NOT c.stopped)`);
      await client.query(
        "UPDATE writer_control SET cleanup_uncertain=false WHERE singleton",
      );
    }, true);
    if (!this.stopping) this.usable = true;
  }

  async grant(
    actor: string,
    purpose: Purpose,
    fingerprint: string,
    ttlMs = 60000,
  ) {
    grantIntent
      .omit({ requestId: true, grantId: true })
      .parse({ actor, purpose, fingerprint });
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60000)
      throw new ServiceError(400, "INVALID_GRANT_TTL");
    return this.transaction((client) =>
      this.grantInTransaction(client, actor, purpose, fingerprint, ttlMs),
    );
  }

  async grantInTransaction(
    client: pg.Client,
    actor: string,
    purpose: Purpose,
    fingerprint: string,
    ttlMs: number,
  ) {
    this.assertTransaction(client);
    grantIntent
      .omit({ requestId: true, grantId: true })
      .parse({ actor, purpose, fingerprint });
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 300000)
      throw new ServiceError(400, "INVALID_GRANT_TTL");
    const id = randomUUID();
    await client.query(
      `INSERT INTO grants(id,actor,purpose,fingerprint,expires_at)
       VALUES($1,$2,$3,$4,clock_timestamp()+$5*interval '1 millisecond')`,
      [id, actor, purpose, fingerprint, ttlMs],
    );
    return id;
  }

  async write<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
    return this.transaction(run);
  }

  async admit(
    input: z.infer<typeof grantIntent>,
    projectId?: string,
  ): Promise<Job> {
    input = grantIntent.parse(input);
    if (projectId !== undefined) validateProjectId(projectId);
    return this.transaction((client) =>
      this.admitInTransaction(client, input, projectId),
    );
  }

  /** @id CODE-CHECK-ADMISSION @implements REQ-CHECK-004 REQ-VIS-001 REQ-VIS-003 */
  async admitInTransaction(
    client: pg.Client,
    input: z.infer<typeof intent>,
    projectId?: string,
  ): Promise<Job> {
    this.assertTransaction(client);
    input = intent.parse(input);
    if (projectId !== undefined) validateProjectId(projectId);
    if (input.purpose === "check" && projectId === undefined)
      throw new ServiceError(400, "CHECK_PROJECT_REQUIRED");
    const project =
      projectId === undefined
        ? undefined
        : await ownedProject(client, input.actor, projectId, true);
    const existing = await client.query<Job>(
      "SELECT * FROM jobs WHERE actor=$1 AND request_id=$2",
      [input.actor, input.requestId],
    );
    if (existing.rowCount) {
      const job = existing.rows[0];
      if (
        job.fingerprint !== input.fingerprint ||
        job.purpose !== input.purpose ||
        (projectId !== undefined && job.project_id !== projectId)
      ) {
        throw new ServiceError(409, "REQUEST_INTENT_CONFLICT");
      }
      return job;
    }
    if (project && project.status !== "active")
      throw new ServiceError(409, "PROJECT_ARCHIVED");
    if (input.purpose !== "check") {
      const grant = await client.query(
        `SELECT * FROM grants WHERE id=$1 AND actor=$2
        AND purpose=$3 AND fingerprint=$4 AND consumed_by IS NULL AND expires_at>clock_timestamp() FOR UPDATE`,
        [input.grantId, input.actor, input.purpose, input.fingerprint],
      );
      if (grant.rowCount !== 1)
        throw new ServiceError(409, "CONFIRMATION_REQUIRED");
    }
    const id = randomUUID();
    const result = await client.query<Job>(
      `INSERT INTO jobs(id,actor,request_id,purpose,fingerprint,epoch,state,project_id)
        VALUES($1,$2,$3,$4,$5,$6,'queued',$7) RETURNING *`,
      [
        id,
        input.actor,
        input.requestId,
        input.purpose,
        input.fingerprint,
        this.epoch,
        projectId ?? null,
      ],
    );
    if (input.purpose !== "check")
      await client.query("UPDATE grants SET consumed_by=$1 WHERE id=$2", [
        id,
        input.grantId,
      ]);
    return result.rows[0];
  }

  async get(actor: string, id: string): Promise<Job> {
    const result = await this.pool.query<Job>(
      `SELECT j.*, CASE WHEN w.cleanup_uncertain OR NOT EXISTS(
        SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE l.locktype='advisory' AND l.granted AND l.classid=0 AND l.objid=918273645
          AND l.objsubid=1 AND l.pid=w.backend_pid AND a.backend_start=w.backend_start)
        THEN 'unknown' ELSE j.cleanup END AS cleanup
        FROM jobs j CROSS JOIN writer_control w WHERE j.actor=$1 AND j.id=$2`,
      [actor, id],
    );
    if (result.rowCount !== 1) throw new ServiceError(404, "JOB_NOT_FOUND");
    return result.rows[0];
  }

  async dispatch(actor: string, id: string) {
    return this.transaction(async (client) => {
      const result = await client.query<Job>(
        `UPDATE jobs SET state='running'
        WHERE id=$1 AND actor=$2 AND epoch=$3 AND state='queued' AND NOT cancel_requested RETURNING *`,
        [id, actor, this.epoch],
      );
      if (result.rowCount !== 1)
        throw new ServiceError(409, "JOB_NOT_DISPATCHABLE");
      return result.rows[0];
    });
  }

  async observeStarted(actor: string, id: string) {
    return this.transaction(async (client) => {
      const result = await client.query<Job>(
        `UPDATE jobs SET started='observed'
        WHERE id=$1 AND actor=$2 AND epoch=$3 AND state='running' RETURNING *`,
        [id, actor, this.epoch],
      );
      if (result.rowCount !== 1) throw new ServiceError(409, "JOB_NOT_RUNNING");
      return result.rows[0];
    });
  }

  async requestCancel(actor: string, id: string) {
    return this.transaction(async (client) => {
      const result = await client.query<Job>(
        `UPDATE jobs SET cancel_requested=true
        WHERE id=$1 AND actor=$2 AND epoch=$3 AND state IN ('queued','running') RETURNING *`,
        [id, actor, this.epoch],
      );
      if (result.rowCount !== 1)
        throw new ServiceError(409, "JOB_TERMINAL_OR_FOREIGN");
      return result.rows[0];
    });
  }

  async registerContainer(
    actor: string,
    jobId: string,
    identity: ContainerIdentity,
  ) {
    if (
      identity.applicationId !== this.credentials.applicationId ||
      identity.controlId !== this.credentials.controlId ||
      identity.resourceId !== jobId
    )
      throw new ServiceError(409, "CONTAINER_IDENTITY_MISMATCH");
    await inspectOwned(identity);
    return this.transaction(async (client) => {
      const job = await client.query(
        "SELECT id FROM jobs WHERE id=$1 AND actor=$2 AND epoch=$3 AND state='running'",
        [jobId, actor, this.epoch],
      );
      if (job.rowCount !== 1) throw new ServiceError(409, "JOB_NOT_RUNNING");
      await client.query(
        `INSERT INTO operation_containers(id,application_id,control_id,resource_id,job_id)
        VALUES($1,$2,$3,$4,$5)`,
        [
          identity.id,
          identity.applicationId,
          identity.controlId,
          identity.resourceId,
          jobId,
        ],
      );
    });
  }

  async finish(actor: string, id: string, terminal: Terminal): Promise<Job> {
    return this.transaction((client) =>
      this.finishInTransaction(client, actor, id, terminal),
    );
  }
  assertTransaction(client: pg.Client) {
    if (client !== this.lease || !this.transactionOpen)
      throw new ServiceError(503, "INVALID_WRITER_TRANSACTION");
  }
  async finishInTransaction(
    client: pg.Client,
    actor: string,
    id: string,
    terminal: Terminal,
  ): Promise<Job> {
    this.assertTransaction(client);
    const current = await client.query<Job>(
      "SELECT * FROM jobs WHERE id=$1 AND actor=$2 AND epoch=$3 FOR UPDATE",
      [id, actor, this.epoch],
    );
    const job = current.rows[0];
    if (!job || !["queued", "running"].includes(job.state))
      throw new ServiceError(409, "JOB_TERMINAL_OR_FOREIGN");
    if (
      terminal === "completed" &&
      (job.state !== "running" ||
        job.started !== "observed" ||
        job.cancel_requested)
    ) {
      throw new ServiceError(409, "JOB_NOT_COMPLETABLE");
    }
    const containers = await client.query(
      "SELECT * FROM operation_containers WHERE job_id=$1 AND NOT stopped",
      [id],
    );
    const persistent = await client.query(
      `SELECT r.* FROM runtime_job_bindings b JOIN runtime_containers r USING(kernel_epoch) WHERE b.job_id=$1`,
      [id],
    );
    let persistentStopped = false;
    for (const row of persistent.rows) {
      if (row.state === "stopped" && row.container_id) {
        const inspected = await inspectOwned({
          id: row.container_id,
          applicationId: row.application_id,
          controlId: row.control_id,
          resourceId: row.kernel_epoch,
        });
        if (inspected.State.Running)
          throw new ServiceError(409, "STOP_UNCONFIRMED");
        persistentStopped = true;
      }
    }
    if (terminal === "cancelled") {
      if (!job.cancel_requested)
        throw new ServiceError(409, "CANCEL_NOT_REQUESTED");
      if (
        job.state === "running" &&
        containers.rowCount === 0 &&
        !persistentStopped
      )
        throw new ServiceError(409, "STOP_UNCONFIRMED");
    }
    for (const row of containers.rows) {
      await stopOwned({
        id: row.id,
        applicationId: row.application_id,
        controlId: row.control_id,
        resourceId: row.resource_id,
      });
      await client.query(
        "UPDATE operation_containers SET stopped=true WHERE id=$1",
        [row.id],
      );
    }
    const result = await client.query<Job>(
      `UPDATE jobs SET state=$1,
        cleanup=$2, started=CASE WHEN state='queued' THEN 'not-started' ELSE started END
        WHERE id=$3 RETURNING *`,
      [
        terminal,
        containers.rowCount || persistentStopped || job.state === "queued"
          ? "verified"
          : "unknown",
        id,
      ],
    );
    return result.rows[0];
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.usable = false;
    await this.tail;
    await this.lease.end();
    await this.pool.end();
  }

  async shutdown() {
    this.stopping = true;
    this.usable = false;
    try {
      if (!this.lost && this.epoch !== null) await this.recover();
    } finally {
      await this.close();
    }
  }
}
