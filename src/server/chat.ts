import type { Operations } from "./operations";
import type { Sessions, ProjectChat } from "./sessions";
import type { Files } from "./files";
import type { Provenance } from "./provenance";
import type { Proposals } from "./proposals";
import type { Confirmations } from "./confirmations";
import type { CopilotPort } from "./copilot";
import type { ChatHistory, TurnContext } from "./chat-context";
import type { StreamOptions, TurnProjection } from "./sse";
import { ServiceError } from "./http";
import type { Job } from "./operations";
import type { FileVersion } from "./files";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ownedProject } from "./project-scope";
import { selectionSchema, validText, encodedJson } from "./chat-context";
import { copilotTools } from "./copilot-tools";

export interface ChatServices {
  operations: Operations;
  sessions: Sessions;
  files: Files;
  provenance: Provenance;
  proposals: Proposals;
  confirmations: Confirmations;
  copilot: CopilotPort;
}

export interface ChatDeadline {
  schedule(milliseconds: number, fire: () => void): () => void;
}

export interface ChatPreview {
  context: TurnContext;
  grantId: string;
}

const contextSchema = z.object({
  prompt: z.string(),
  selections: z.array(selectionSchema).max(32).default([]),
}).strict();
const submissionSchema = contextSchema.extend({
  requestId: z.uuid().transform((value) => value.toLowerCase()),
  grantId: z.uuid().transform((value) => value.toLowerCase()),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
const receiptSchema = z.object({
  kind: z.literal("context"),
  fingerprint: z.string(),
  grantId: z.string(),
  selections: z.array(selectionSchema),
}).strict();
type Submission = z.infer<typeof submissionSchema>;
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success) throw new ServiceError(400, "INVALID_CHAT_INPUT");
  return value.data;
}
function prompt(value: string) {
  validText(value, 16000);
  if (!value.trim()) throw new ServiceError(400, "INVALID_CHAT_INPUT");
}
const activeRequests = new WeakMap<Operations, Map<string, {
  intent: string;
  response: Promise<TurnProjection>;
}>>();
function requests(operations: Operations) {
  let map = activeRequests.get(operations);
  if (!map) {
    map = new Map();
    activeRequests.set(operations, map);
  }
  return map;
}

/** @id CODE-CHAT-TURNS @implements REQ-CHAT-001 REQ-CHAT-002 */
export class Chat {
  constructor(
    readonly services: ChatServices,
    readonly options: { deadline?: ChatDeadline } = {},
  ) {}

  async open(
    actor: string,
    projectId: string,
  ): Promise<{ project: ProjectChat; history: ChatHistory }> {
    return {
      project: await this.services.sessions.open(actor, projectId),
      history: await this.services.sessions.history(actor, projectId),
    };
  }

  async preview(
    actor: string,
    projectId: string,
    input: unknown,
  ): Promise<ChatPreview> {
    const value = parse(contextSchema, input);
    prompt(value.prompt);
    const context = await this.services.sessions.previewContext(actor, projectId, value.prompt, value.selections);
    const grantId = await this.services.operations.grant(actor, "chat", context.fingerprint);
    return { context, grantId };
  }

  async submit(
    actor: string,
    projectId: string,
    input: unknown,
  ): Promise<TurnProjection> {
    const value = parse(submissionSchema, input);
    prompt(value.prompt);
    const intent = JSON.stringify({ projectId, ...value });
    const key = JSON.stringify([actor, value.requestId]);
    const map = requests(this.services.operations);
    const active = map.get(key);
    if (active) {
      if (active.intent !== intent)
        throw new ServiceError(409, "REQUEST_INTENT_CONFLICT");
      return active.response;
    }
    const response = this.run(actor, projectId, value);
    map.set(key, { intent, response });
    try {
      return await response;
    } finally {
      map.delete(key);
    }
  }

  private async run(actor: string, projectId: string, value: Submission): Promise<TurnProjection> {
    const { operations, sessions, provenance, files, proposals, confirmations, copilot } = this.services;
    const admitted = await operations.write(async (client) => {
      const project = await ownedProject(client, actor, projectId, true);
      const prior = await client.query<Job & { turnId: string | null; prompt: string | null; intent: unknown }>(
        `SELECT j.*,t.id AS "turnId",t.prompt,e.payload AS intent FROM jobs j
         LEFT JOIN chat_turns t ON t.job_id=j.id
         LEFT JOIN chat_events e ON e.turn_id=t.id AND e.sequence=1
         WHERE j.actor=$1 AND j.request_id=$2`,
        [actor, value.requestId],
      );
      const sealed = { kind: "context", fingerprint: value.fingerprint, grantId: value.grantId, selections: value.selections };
      if (prior.rowCount) {
        const job = prior.rows[0];
        const stored = receiptSchema.safeParse(job.intent);
        if (job.project_id !== project.id || job.purpose !== "chat" ||
          job.fingerprint !== value.fingerprint || job.prompt !== value.prompt ||
          !stored.success || JSON.stringify(stored.data) !== JSON.stringify(sealed))
          throw new ServiceError(409, "REQUEST_INTENT_CONFLICT");
        if (!job.turnId) throw new ServiceError(409, "REQUEST_INTENT_CONFLICT");
        return { turnId: job.turnId, jobId: job.id, context: null };
      }
      if (project.status !== "active") throw new ServiceError(409, "PROJECT_ARCHIVED");
      const busy = await client.query(
        "SELECT id FROM jobs WHERE project_id=$1 AND actor=$2 AND purpose='chat' AND state IN ('queued','running')",
        [project.id, actor],
      );
      if (busy.rowCount) throw new ServiceError(409, "PROJECT_CHAT_BUSY");
      const context = await sessions.authorizedContext(actor, project.id, value.prompt, value.selections, value.grantId);
      if (context.fingerprint !== value.fingerprint)
        throw new ServiceError(409, "CONTEXT_CONFIRMATION_REQUIRED");
      const job = await operations.admitInTransaction(client, {
        actor, requestId: value.requestId, purpose: "chat",
        fingerprint: context.fingerprint, grantId: value.grantId,
      }, project.id);
      const turnId = randomUUID();
      const encoded = encodedJson(sealed, 64 * 1024, "INVALID_CHAT_INPUT", "CHAT_CONTEXT_TOO_LARGE");
      await client.query(
        `INSERT INTO chat_turns(id,project_id,chat_id,actor,job_id,prompt,event_count,event_bytes)
         VALUES($1,$2,$3,$4,$5,$6,1,$7)`,
        [turnId, project.id, project.chatId, actor, job.id, value.prompt, Buffer.byteLength(encoded)],
      );
      await client.query(
        "INSERT INTO chat_events(turn_id,sequence,kind,payload) VALUES($1,1,'tool',$2::jsonb)",
        [turnId, encoded],
      );
      return { turnId, jobId: job.id, context };
    });
    if (!admitted.context) {
      const prior = await sessions.turn(actor, projectId, admitted.turnId);
      if (prior.state === "completed") return prior;
      if (prior.state === "running" || prior.state === "queued")
        throw new ServiceError(409, "PROJECT_CHAT_BUSY");
      throw new ServiceError(502, "COPILOT_FAILED");
    }
    const abort = new AbortController();
    const artifacts: FileVersion[] = [];
    let timedOut = false;
    let partial = "";
    const fire = () => { timedOut = true; abort.abort(); };
    const cancelDeadline = this.options.deadline
      ? this.options.deadline.schedule(120000, fire)
      : (() => {
        const timer = setTimeout(fire, 120000);
        return () => clearTimeout(timer);
      })();
    const append = async (text: string) => {
      for (let offset = 0; offset < text.length; ) {
        abort.signal.throwIfAborted();
        // Avoid splitting UTF-16 surrogate pairs at durable event boundaries.
        let end = Math.min(offset + 10000, text.length);
        const last = text.charCodeAt(end - 1);
        if (last >= 0xd800 && last <= 0xdbff && end < text.length) end--;
        const chunk = text.slice(offset, end);
        await sessions.recordEvent(actor, projectId, admitted.turnId, { kind: "partial", text: chunk });
        partial += chunk;
        offset = end;
      }
    };
    try {
      await operations.dispatch(actor, admitted.jobId);
      const response = await copilot.reply({
        context: admitted.context,
        signal: abort.signal,
        onStarted: async () => { await operations.observeStarted(actor, admitted.jobId); },
        onText: append,
        tools: copilotTools({
          actor, projectId, turnId: admitted.turnId, files, proposals, confirmations,
          excerpts: admitted.context.excerpts, artifacts, signal: abort.signal,
          onEvent: async (event) => {
            abort.signal.throwIfAborted();
            await sessions.recordEvent(actor, projectId, admitted.turnId, event);
          },
        }),
      });
      abort.signal.throwIfAborted();
      validText(response, 2 * 1024 * 1024);
      if (!response.trim() || Buffer.byteLength(response) > 2 * 1024 * 1024)
        throw new ServiceError(502, "COPILOT_NO_SUCCESSFUL_REPLY");
      if (response.startsWith(partial)) {
        await append(response.slice(partial.length));
      } else {
        await operations.write(async (client) => {
          const updated = await client.query(
            `UPDATE chat_turns t SET response=$1 FROM jobs j
             WHERE t.id=$2 AND t.project_id=$3 AND t.actor=$4 AND j.id=t.job_id
             AND j.state='running' AND j.epoch=(SELECT epoch FROM writer_control)`,
            [response, admitted.turnId, projectId, actor],
          );
          if (updated.rowCount !== 1) throw new ServiceError(409, "TURN_NOT_RUNNING");
        });
      }
      abort.signal.throwIfAborted();
      await provenance.finishTurn(actor, projectId, admitted.turnId, { status: "completed", artifacts });
      return await sessions.turn(actor, projectId, admitted.turnId);
    } catch {
      abort.abort();
      const discarded = await Promise.allSettled(artifacts.map((file) => files.discardPrepared(file)));
      try {
        const job = await operations.get(actor, admitted.jobId);
        if (job.state === "queued" || job.state === "running")
          await provenance.finishTurn(actor, projectId, admitted.turnId, {
            status: timedOut ? "timeout" : "failed", artifacts: [],
          });
      } catch {
        console.error("CHAT_TERMINAL_PUBLICATION_UNCERTAIN");
      }
      if (discarded.some((entry) => entry.status === "rejected"))
        console.error("CHAT_ARTIFACT_CLEANUP_UNCERTAIN");
      throw new ServiceError(502, timedOut ? "COPILOT_TIMEOUT" : "COPILOT_FAILED");
    } finally {
      abort.abort();
      cancelDeadline();
    }
  }

  async turn(
    actor: string,
    projectId: string,
    turnId: string,
    after = 0,
  ): Promise<TurnProjection> {
    return this.services.sessions.turn(actor, projectId, turnId, after);
  }

  async events(
    actor: string,
    projectId: string,
    turnId: string,
    options: StreamOptions = {},
  ): Promise<Response> {
    return this.services.sessions.events(actor, projectId, turnId, options);
  }
}
