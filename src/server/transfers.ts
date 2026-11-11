import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { ServiceError } from "./http";
import { outputsSchema, type RunOutput } from "./run-snapshots";

export const RAW_CHUNK_BYTES = 512 * 1024;
const FRAME_BYTES = 1024 * 1024;
const DISPLAY_BYTES = 2 * 1024 * 1024;
export const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const offset = z.number().int().nonnegative().safe();
const chunkSchema = z.object({ transferId: z.uuid(), offset, data: z.string(), sha256: hash }).strict();
const ackSchema = chunkSchema.omit({ data: true });
export interface ChunkExpectation { transferId: string; offset: number }
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ServiceError(400, "INVALID_TRANSFER_FRAME");
  return result.data;
}
/** @id CODE-RUN-TRANSFERS @implements REQ-RUN-004 */
export function decodeChunk(input: unknown, expected: ChunkExpectation): Buffer {
  const value = parse(chunkSchema, input);
  if (Buffer.byteLength(JSON.stringify(input)) > FRAME_BYTES || value.data.length > Math.ceil(RAW_CHUNK_BYTES / 3) * 4)
    throw new ServiceError(413, "TRANSFER_CHUNK_TOO_LARGE");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))
    throw new ServiceError(400, "INVALID_TRANSFER_ENCODING");
  const data = Buffer.from(value.data, "base64");
  if (data.length > RAW_CHUNK_BYTES) throw new ServiceError(413, "TRANSFER_CHUNK_TOO_LARGE");
  if (data.toString("base64") !== value.data) throw new ServiceError(400, "INVALID_TRANSFER_ENCODING");
  if (value.transferId !== expected.transferId || value.offset !== expected.offset || digest(data) !== value.sha256)
    throw new ServiceError(409, "TRANSFER_INTEGRITY_ERROR");
  return data;
}
export function verifyAck(input: unknown, expected: ChunkExpectation & { sha256: string }): void {
  const value = parse(ackSchema, input);
  if (value.transferId !== expected.transferId || value.offset !== expected.offset || value.sha256 !== expected.sha256)
    throw new ServiceError(409, "TRANSFER_ACK_MISMATCH");
}
export type WorkerFrame = Record<string, unknown> & { kind: string; id?: string };
const frameSchema = z.object({ kind: z.string(), id: z.uuid().optional() }).loose();
interface Pending {
  frame: (frame: WorkerFrame) => Promise<void>;
  reject: (error: Error) => void;
}
/** @id CODE-RUN-CHANNEL @implements REQ-RUN-001 REQ-RUN-003 REQ-RUN-004 */
export class RuntimeChannel {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private buffer = Buffer.alloc(0);
  private chain = Promise.resolve();
  private failure: Error | undefined;
  private helloResolve!: () => void;
  private helloReject!: (error: Error) => void;
  private readonly hello: Promise<void>;
  constructor(containerId: string) {
    if (!/^[a-f0-9]{64}$/.test(containerId)) throw new ServiceError(503, "INVALID_CONTAINER_ID");
    this.hello = new Promise((resolve, reject) => { this.helloResolve = resolve; this.helloReject = reject; });
    void this.hello.catch(() => {});
    this.child = spawn("docker", ["start", "-ai", containerId], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    this.child.on("error", () => this.fail(new ServiceError(503, "RUNTIME_ATTACH_FAILED")));
    this.child.stdin.on("error", () => this.fail(new ServiceError(503, "RUNTIME_CHANNEL_CLOSED")));
    this.child.on("close", () => this.fail(new ServiceError(503, "RUNTIME_PROCESS_EXITED")));
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      this.child.stdout.pause();
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let end: number;
      while ((end = this.buffer.indexOf(10)) !== -1) {
        const line = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        if (line.length > FRAME_BYTES) { this.fail(new ServiceError(413, "RUNTIME_FRAME_TOO_LARGE")); return; }
        this.chain = this.chain.then(async () => {
          let value: unknown;
          try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
          catch { throw new ServiceError(503, "INVALID_RUNTIME_FRAME"); }
          const parsed = frameSchema.safeParse(value);
          if (!parsed.success) throw new ServiceError(503, "INVALID_RUNTIME_FRAME");
          const frame = parsed.data;
          if (frame.kind === "hello" && frame.id === undefined && frame.version === 1) { this.helloResolve(); return; }
          if (!frame.id || !this.pending.has(frame.id)) throw new ServiceError(503, "UNEXPECTED_RUNTIME_FRAME");
          if (frame.kind === "error") {
            const error = z.object({ id: z.uuid(), kind: z.literal("error"), status: z.union([z.literal(400), z.literal(409), z.literal(413), z.literal(504), z.literal(503)]), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/) }).strict().safeParse(frame);
            throw error.success ? new ServiceError(error.data.status, error.data.code) : new ServiceError(503, "INVALID_RUNTIME_ERROR");
          }
          await this.pending.get(frame.id)!.frame(frame);
        }).catch(error => this.fail(error instanceof Error ? error : new ServiceError(503, "RUNTIME_CHANNEL_FAILED")));
      }
      if (this.buffer.length > FRAME_BYTES) this.fail(new ServiceError(413, "RUNTIME_FRAME_TOO_LARGE"));
      void this.chain.then(() => { if (!this.failure) this.child.stdout.resume(); });
    });
  }
  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.helloReject(error);
    for (const value of this.pending.values()) value.reject(error);
    this.pending.clear();
  }
  private send(frame: WorkerFrame) {
    if (this.failure) throw this.failure;
    const data = JSON.stringify(frame);
    if (Buffer.byteLength(data) > FRAME_BYTES) throw new ServiceError(413, "RUNTIME_FRAME_TOO_LARGE");
    this.child.stdin.write(data + "\n");
  }
  async ready() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.hello, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ServiceError(504, "RUNTIME_START_TIMEOUT")), 30000); })]); }
    finally { clearTimeout(timer); }
  }
  request(input: WorkerFrame, timeoutMs = 10000): Promise<WorkerFrame> {
    if (this.failure) return Promise.reject(this.failure);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new ServiceError(504, "TRANSFER_ACK_TIMEOUT")), timeoutMs);
      this.pending.set(id, {
        frame: async frame => { clearTimeout(timer); this.pending.delete(id); resolve(frame); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { this.send({ ...input, id }); } catch (error) { this.fail(error instanceof Error ? error : new ServiceError(503, "RUNTIME_CHANNEL_FAILED")); }
    });
  }
  execute(source: string, language: "python" | "r", sharing: unknown, observed: () => Promise<unknown>): Promise<RunOutput[]> {
    if (this.failure) return Promise.reject(this.failure);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let started = false, position = 0;
      let output: { id: string; size: number; sha256: string; data: Buffer } | undefined;
      const reset = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => this.fail(new ServiceError(504, "EXECUTION_TIMEOUT")), ms); };
      reset(30000);
      this.pending.set(id, {
        reject: error => { clearTimeout(timer); reject(error); },
        frame: async frame => {
          if (frame.kind === "started" && !started && !output) { started = true; await observed(); return; }
          if (frame.kind === "result-begin" && !output) {
            const begin = parse(z.object({ id: z.uuid(), kind: z.literal("result-begin"), transferId: z.uuid(), size: offset.max(DISPLAY_BYTES), sha256: hash, status: z.enum(["ok", "error"]) }).strict(), frame);
            if (!started) throw new ServiceError(503, "EXECUTION_START_UNOBSERVED");
            output = { id: begin.transferId, size: begin.size, sha256: begin.sha256, data: Buffer.alloc(begin.size) };
            reset(10000); return;
          }
          if (frame.kind === "result-chunk" && output) {
            const value = parse(chunkSchema.extend({ id: z.uuid(), kind: z.literal("result-chunk") }), frame);
            const { transferId, offset: at, data, sha256 } = value;
            const chunk = decodeChunk({ transferId, offset: at, data, sha256 }, { transferId: output.id, offset: position });
            if (!chunk.length || position + chunk.length > output.size) throw new ServiceError(503, "RUNTIME_OUTPUT_SIZE_MISMATCH");
            chunk.copy(output.data, position); position += chunk.length;
            this.send({ id, kind: "ack", transferId, offset: position, sha256 });
            reset(10000); return;
          }
          if (frame.kind === "result-end" && output) {
            const end = parse(z.object({ id: z.uuid(), kind: z.literal("result-end"), transferId: z.uuid(), size: offset, sha256: hash }).strict(), frame);
            if (end.transferId !== output.id || position !== output.size || end.size !== output.size || end.sha256 !== output.sha256 || digest(output.data) !== output.sha256)
              throw new ServiceError(503, "RUNTIME_OUTPUT_INTEGRITY_ERROR");
            let value: unknown;
            try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output.data)); }
            catch { throw new ServiceError(503, "INVALID_RUNTIME_OUTPUT"); }
            const outputs = z.object({ outputs: outputsSchema }).strict().safeParse(value);
            if (!outputs.success) throw new ServiceError(503, "INVALID_RUNTIME_OUTPUT");
            this.send({ id, kind: "ack", transferId: output.id, offset: position, sha256: output.sha256 });
            clearTimeout(timer); this.pending.delete(id); resolve(outputs.data.outputs); return;
          }
          throw new ServiceError(503, "UNEXPECTED_RUNTIME_EXECUTION_FRAME");
        },
      });
      try { this.send({ id, kind: "execute", source, language, sharing }); }
      catch (error) { this.fail(error instanceof Error ? error : new ServiceError(503, "RUNTIME_CHANNEL_FAILED")); }
    });
  }
  close() {
    this.fail(new ServiceError(503, "RUNTIME_CHANNEL_CLOSED"));
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }
  abort(error: ServiceError) {
    this.fail(error);
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }
}
