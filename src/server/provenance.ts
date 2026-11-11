import pg from "pg";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { databaseConfig } from "./database";
import type { Credentials } from "./credentials";
import type { Operations, Terminal } from "./operations";
import type { Files, FileVersion } from "./files";
import type { CaptureInput, CapturedRun, RunOutput } from "./run-snapshots";
import { ServiceError } from "./http";
import { ownedProject, projectId as validId } from "./project-scope";
import { encodedJson } from "./chat-context";
import { captureSchema, outputsSchema } from "./run-snapshots";
const RUN_SELECT = `SELECT r.id,r.sequence::text,r.actor,r.project_id AS "projectId",
 r.chat_id AS "chatId",r.notebook_id AS "notebookId",r.cell_id AS "cellId",r.job_id AS "jobId",
 r.revision,r.source,r.language,r.sharing,r.inputs,r.environment,r.kernel_epoch AS "kernelEpoch",
 r.created_at::text AS "createdAt",j.dispatched_at::text AS "dispatchedAt",
 j.started_at::text AS "startedAt",j.ended_at::text AS "endedAt",j.state AS status,result.outputs
 FROM runs r JOIN jobs j ON j.id=r.job_id LEFT JOIN run_results result ON result.run_id=r.id`;
export interface ArtifactRecord extends FileVersion {
  createdAt: string;
  origin: {
    kind: "unavailable" | "upload" | "run" | "turn";
    chatId: string | null;
    notebookId: string | null;
    runId: string | null;
    turnId: string | null;
    status: string;
  };
}
/** @id CODE-PROV-RECORDS @implements REQ-PROV-001 REQ-PROV-002 REQ-PROV-003 */
export class Provenance {
  private readonly pool: pg.Pool;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly operations: Operations,
    private readonly files: Files,
    state: string,
    credentials: Credentials,
  ) {
    this.pool = new pg.Pool({
      ...databaseConfig(state, credentials, "application"),
      max: 4,
    });
    this.pool.on("error", () =>
      console.error("PROVENANCE_DATABASE_CONNECTION_LOST"),
    );
  }
  async capture(
    actor: string,
    projectId: string,
    input: CaptureInput,
  ): Promise<CapturedRun> {
    const parsed = captureSchema.safeParse(input);
    if (!parsed.success) throw new ServiceError(400, "INVALID_RUN_SNAPSHOT");
    const snapshot = parsed.data;
    encodedJson(
      snapshot,
      12 * 1024 * 1024,
      "INVALID_RUN_SNAPSHOT",
      "RUN_SNAPSHOT_TOO_LARGE",
    );
    const selected = await this.files.select(actor, projectId, snapshot.inputs);
    const inputs = selected.map((file) => ({
      id: file.id,
      workspaceName: file.workspaceName,
      size: file.size,
      sha256: file.sha256,
    }));
    return this.operations.write(async (client) => {
      const project = await ownedProject(client, actor, projectId, true);
      if (project.status !== "active")
        throw new ServiceError(409, "PROJECT_ARCHIVED");
      const notebook = await client.query(
        "SELECT id FROM notebook_links WHERE id=$1 AND actor=$2 AND project_id=$3",
        [snapshot.notebookId, actor, projectId],
      );
      if (notebook.rowCount !== 1)
        throw new ServiceError(404, "NOTEBOOK_NOT_FOUND");
      const job = await client.query(
        `SELECT id FROM jobs WHERE id=$1 AND actor=$2 AND project_id=$3 AND purpose='execution'
         AND state='queued' AND NOT cancel_requested AND epoch=(SELECT epoch FROM writer_control) FOR UPDATE`,
        [snapshot.jobId, actor, projectId],
      );
      if (job.rowCount !== 1)
        throw new ServiceError(409, "SNAPSHOT_REQUIRES_QUEUED_JOB");
      const existing = await client.query(
        "SELECT id FROM runs WHERE job_id=$1",
        [snapshot.jobId],
      );
      if (existing.rowCount)
        throw new ServiceError(409, "RUN_SNAPSHOT_ALREADY_CAPTURED");
      const id = randomUUID();
      await client.query(
        `INSERT INTO runs(id,actor,project_id,chat_id,notebook_id,cell_id,job_id,revision,source,language,sharing,inputs,environment,kernel_epoch)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14)`,
        [
          id,
          actor,
          projectId,
          project.chatId,
          snapshot.notebookId,
          snapshot.cellId,
          snapshot.jobId,
          snapshot.revision,
          snapshot.source,
          snapshot.language,
          JSON.stringify(snapshot.sharing),
          JSON.stringify(inputs),
          snapshot.environment === null
            ? null
            : JSON.stringify(snapshot.environment),
          snapshot.kernelEpoch,
        ],
      );
      return this.read(client, actor, projectId, id);
    });
  }
  private async read(
    client: pg.Pool | pg.Client,
    actor: string,
    projectId: string,
    id: string,
  ): Promise<CapturedRun> {
    const result = await client.query<CapturedRun>(
      `${RUN_SELECT} WHERE r.id=$1 AND r.actor=$2 AND r.project_id=$3`,
      [id, actor, projectId],
    );
    if (result.rowCount !== 1) throw new ServiceError(404, "RUN_NOT_FOUND");
    return result.rows[0];
  }
  async get(
    actor: string,
    projectId: string,
    id: string,
  ): Promise<CapturedRun> {
    validId(id);
    await ownedProject(this.pool, actor, projectId);
    return this.read(this.pool, actor, projectId, id);
  }
  async history(
    actor: string,
    projectId: string,
    notebookId: string,
  ): Promise<CapturedRun[]> {
    validId(notebookId);
    await ownedProject(this.pool, actor, projectId);
    const notebook = await this.pool.query(
      "SELECT id FROM notebook_links WHERE id=$1 AND actor=$2 AND project_id=$3",
      [notebookId, actor, projectId],
    );
    if (notebook.rowCount !== 1)
      throw new ServiceError(404, "NOTEBOOK_NOT_FOUND");
    return (
      await this.pool.query<CapturedRun>(
        `${RUN_SELECT} WHERE r.notebook_id=$1 AND r.actor=$2 AND r.project_id=$3 ORDER BY r.sequence DESC`,
        [notebookId, actor, projectId],
      )
    ).rows;
  }
  async artifact(
    actor: string,
    projectId: string,
    id: string,
  ): Promise<ArtifactRecord> {
    const file = await this.files.get(actor, projectId, id);
    const result = await this.pool.query<{
      createdAt: string;
      origin: ArtifactRecord["origin"];
    }>(
      `SELECT f.created_at::text AS "createdAt",jsonb_build_object(
        'kind',f.origin_kind,'chatId',f.chat_id,'notebookId',f.notebook_id,'runId',f.run_id,'turnId',f.turn_id,
        'status',CASE WHEN f.origin_kind='upload' THEN 'uploaded' WHEN f.origin_kind='unavailable' THEN 'unavailable' ELSE j.state END
      ) AS origin FROM file_versions f LEFT JOIN runs r ON r.id=f.run_id
      LEFT JOIN chat_turns t ON t.id=f.turn_id LEFT JOIN jobs j ON j.id=coalesce(r.job_id,t.job_id)
      WHERE f.id=$1 AND f.project_id=$2 AND f.actor=$3`,
      [id, projectId, actor],
    );
    if (result.rowCount !== 1) throw new ServiceError(404, "FILE_NOT_FOUND");
    return { ...file, ...result.rows[0] };
  }
  prepareArtifact(
    actor: string,
    projectId: string,
    name: string,
    mime: string,
    body: AsyncIterable<Uint8Array>,
  ): Promise<FileVersion> {
    return this.files.prepare(actor, projectId, name, mime, body);
  }
  private validateArtifacts(
    actor: string,
    projectId: string,
    artifacts: FileVersion[],
  ) {
    if (!Array.isArray(artifacts))
      throw new ServiceError(400, "INVALID_ARTIFACTS");
    const ids = new Set<string>();
    let bytes = 0;
    for (const file of artifacts) {
      this.files.assertPrepared(file);
      if (file.actor !== actor || file.projectId !== projectId)
        throw new ServiceError(404, "FILE_NOT_FOUND");
      if (ids.has(file.id)) throw new ServiceError(409, "ARTIFACT_COLLISION");
      ids.add(file.id);
      bytes += file.size;
      if (bytes > 256 * 1024 * 1024)
        throw new ServiceError(413, "ARTIFACT_BUDGET_EXCEEDED");
    }
  }
  private async failedPublication(
    error: unknown,
    artifacts: FileVersion[],
  ): Promise<never> {
    const cleanup = await Promise.allSettled(
      artifacts.map((file) => this.files.discardPrepared(file)),
    );
    const failed = cleanup
      .filter((r) => r.status === "rejected")
      .map((r) => r.reason);
    if (failed.length)
      throw new AggregateError(
        [error, ...failed],
        "ARTIFACT_PUBLICATION_CLEANUP_UNCERTAIN",
      );
    throw error;
  }
  private ownedPrepared(
    actor: string,
    projectId: string,
    artifacts: unknown,
  ): FileVersion[] {
    if (!Array.isArray(artifacts)) return [];
    return [
      ...new Set(
        artifacts
          .filter((file): file is FileVersion => this.files.isPrepared(file))
          .filter(
            (file) => file.actor === actor && file.projectId === projectId,
          ),
      ),
    ];
  }
  async finish(
    actor: string,
    projectId: string,
    id: string,
    input: { status: Terminal; outputs: RunOutput[]; artifacts: FileVersion[] },
    notebookId?: string,
  ): Promise<CapturedRun> {
    const prepared = this.ownedPrepared(actor, projectId, input?.artifacts);
    try {
      const run = await this.get(actor, projectId, id);
      if (notebookId !== undefined) {
        validId(notebookId);
        if (run.notebookId !== notebookId.toLowerCase())
          throw new ServiceError(404, "RUN_NOT_FOUND");
      }
      this.validateArtifacts(actor, projectId, input.artifacts);
      const terminal = z
        .enum(["completed", "failed", "timeout", "cancelled", "interrupted"])
        .safeParse(input.status);
      if (!terminal.success)
        throw new ServiceError(400, "INVALID_TERMINAL_STATUS");
      let outputs: z.infer<typeof outputsSchema>;
      try {
        outputs = outputsSchema.parse(input.outputs);
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof RangeError)
          throw new ServiceError(400, "INVALID_RUN_OUTPUT");
        throw error;
      }
      const encoded = encodedJson(
        outputs,
        2 * 1024 * 1024,
        "INVALID_RUN_OUTPUT",
        "RUN_OUTPUT_TOO_LARGE",
      );
      return await this.operations.write(async (client) => {
        await this.operations.finishInTransaction(
          client,
          actor,
          run.jobId,
          terminal.data,
        );
        for (const file of input.artifacts)
          await this.files.commitPrepared(client, file, {
            kind: "run",
            runId: run.id,
            notebookId: run.notebookId,
          });
        await client.query(
          "INSERT INTO run_results(run_id,outputs,output_bytes) VALUES($1,$2::jsonb,$3)",
          [id, encoded, Buffer.byteLength(encoded)],
        );
        return this.read(client, actor, projectId, id);
      });
    } catch (error) {
      return this.failedPublication(error, prepared);
    }
  }
  async finishTurn(
    actor: string,
    projectId: string,
    id: string,
    input: { status: Terminal; artifacts: FileVersion[] },
  ): Promise<void> {
    const prepared = this.ownedPrepared(actor, projectId, input?.artifacts);
    try {
      validId(id);
      await ownedProject(this.pool, actor, projectId);
      this.validateArtifacts(actor, projectId, input.artifacts);
      const turn = await this.pool.query<{ job_id: string }>(
        "SELECT job_id FROM chat_turns WHERE id=$1 AND actor=$2 AND project_id=$3",
        [id, actor, projectId],
      );
      if (turn.rowCount !== 1) throw new ServiceError(404, "TURN_NOT_FOUND");
      const terminal = z
        .enum(["completed", "failed", "timeout", "cancelled", "interrupted"])
        .safeParse(input.status);
      if (!terminal.success)
        throw new ServiceError(400, "INVALID_TERMINAL_STATUS");
      await this.operations.write(async (client) => {
        await this.operations.finishInTransaction(
          client,
          actor,
          turn.rows[0].job_id,
          terminal.data,
        );
        for (const file of input.artifacts)
          await this.files.commitPrepared(client, file, {
            kind: "turn",
            turnId: id,
          });
      });
    } catch (error) {
      return this.failedPublication(error, prepared);
    }
  }
  close() {
    return (this.closing ??= this.pool.end());
  }
}
