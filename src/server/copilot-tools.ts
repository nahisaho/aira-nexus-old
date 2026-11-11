import type { Tool } from "@github/copilot-sdk";
import type { Files, FileVersion } from "./files";
import type { Proposals } from "./proposals";
import type { Confirmations } from "./confirmations";
import type { TurnContext } from "./chat-context";
import type { TurnEvent } from "./sse";
import { ServiceError } from "./http";
import { z } from "zod";
import { encodedJson, selectionSchema } from "./chat-context";

export interface CopilotToolScope {
  actor: string;
  projectId: string;
  turnId: string;
  files: Files;
  proposals: Proposals;
  confirmations: Confirmations;
  excerpts: TurnContext["excerpts"];
  artifacts: FileVersion[];
  signal: AbortSignal;
  onEvent: (event: TurnEvent) => Promise<void>;
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new ServiceError(400, "INVALID_TOOL_ARGUMENTS");
  return parsed.data;
}

/** @id CODE-CHAT-TOOLS @implements REQ-CHAT-003 REQ-CHAT-004 */
export function copilotTools(scope: CopilotToolScope): Tool<unknown>[] {
  function tool(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    run: (args: unknown, signal: AbortSignal) => Promise<unknown>,
  ): Tool<unknown> {
    return {
      name, description, parameters, skipPermission: true, defer: "never",
      handler: async (args, invocation) => {
        const signal = invocation.signal
          ? AbortSignal.any([scope.signal, invocation.signal])
          : scope.signal;
        try {
          signal.throwIfAborted();
          encodedJson(args, 8 * 1024 * 1024, "INVALID_TOOL_ARGUMENTS", "TOOL_ARGUMENTS_TOO_LARGE");
          const result = await run(args, signal);
          signal.throwIfAborted();
          return {
            resultType: "success",
            textResultForLlm: JSON.stringify(result),
          };
        } catch (error) {
          const code = error instanceof ServiceError ? error.code : "TOOL_FAILED";
          return { resultType: "failure", error: code, textResultForLlm: code };
        }
      },
    };
  }
  const object = (properties: Record<string, unknown>, required: string[]) => ({
    type: "object", properties, required, additionalProperties: false,
  });
  const uuid = { type: "string", format: "uuid" };
  const cellProperties = {
    id: { type: "string", description: "Stable unique Notebook cell ID." },
    source: { type: "string", description: "Cell text, at most65536 UTF-8 bytes." },
  };
  const cell = {
    anyOf: [
      object({
        ...cellProperties,
        cell_type: { const: "code" },
        language: { enum: ["python", "r"] },
        sharing: {
          type: "array",
          items: object({
            name: { type: "string" },
            direction: { enum: ["python-to-r", "r-to-python"] },
            family: { enum: ["scalar", "array", "table"] },
          }, ["name", "direction"]),
        },
      }, ["id", "cell_type", "source", "language", "sharing"]),
      object({ ...cellProperties, cell_type: { const: "markdown" } }, ["id", "cell_type", "source"]),
      object({ ...cellProperties, cell_type: { const: "raw" } }, ["id", "cell_type", "source"]),
    ],
  };
  return [
    tool("save_file", "Save UTF-8 text as a new immutable chat artifact. Maximum text size1MiB; basename only.",
      object({ name: { type: "string" }, text: { type: "string" } }, ["name", "text"]),
      async (args, signal) => {
        const value = parse(z.object({ name: z.string(), text: z.string() }).strict(), args);
        if (Buffer.byteLength(value.text, "utf8") > 1024 * 1024)
          throw new ServiceError(413, "CHAT_FILE_TOO_LARGE");
        if (Buffer.from(value.text, "utf8").toString("utf8") !== value.text)
          throw new ServiceError(400, "INVALID_FILE_TEXT");
        async function* body() { yield Buffer.from(value.text, "utf8"); }
        const file = await scope.files.prepare(scope.actor, scope.projectId, value.name, "text/plain", body());
        try {
          signal.throwIfAborted();
          scope.artifacts.push(file);
          await scope.onEvent({ kind: "tool", payload: { kind: "artifact", id: file.id, name: file.name, size: file.size } });
          signal.throwIfAborted();
          return { id: file.id, name: file.name, size: file.size, sha256: file.sha256, pending: true };
        } catch (error) {
          const index = scope.artifacts.indexOf(file);
          if (index >= 0) scope.artifacts.splice(index, 1);
          await scope.files.discardPrepared(file);
          throw error;
        }
      }),
    tool("read_excerpt", "Read only an exact excerpt already included in this turn's user-confirmed context.",
      object({ kind: { enum: ["file", "result"] }, sourceId: uuid, start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 } }, ["kind", "sourceId", "start", "end"]),
      async (args) => {
        const value = parse(selectionSchema, args);
        const excerpt = scope.excerpts.find((entry) => entry.kind === value.kind && entry.sourceId === value.sourceId && entry.start === value.start && entry.end === value.end);
        if (!excerpt) throw new ServiceError(409, "EXCERPT_NOT_CONSENTED");
        return { ...value, text: excerpt.text };
      }),
    tool("propose_notebook", "Propose Notebook creation. Does not create a Notebook or execute code.",
      object({ name: { type: "string", maxLength: 120 }, cells: { type: "array", items: cell, maxItems: 100 } }, ["name", "cells"]),
      async (args, signal) => {
        const value = parse(z.object({ name: z.string(), cells: z.array(z.unknown()).max(100) }).strict(), args);
        signal.throwIfAborted();
        const proposal = await scope.proposals.propose(scope.actor, scope.projectId, { kind: "create-notebook", ...value });
        await scope.onEvent({ kind: "proposal", payload: { kind: "create-notebook", id: proposal.id, state: proposal.state } });
        return { id: proposal.id, state: proposal.state };
      }),
    tool("propose_cell_change", "Propose a cell replacement against an exact Notebook revision. Does not edit or execute.",
      object({ notebookId: uuid, revision: { type: "integer", minimum: 1 }, cell }, ["notebookId", "revision", "cell"]),
      async (args, signal) => {
        const value = parse(z.object({ notebookId: z.uuid(), revision: z.number().int().positive(), cell: z.unknown() }).strict(), args);
        signal.throwIfAborted();
        const proposal = await scope.proposals.propose(scope.actor, scope.projectId, { kind: "change-cell", ...value });
        await scope.onEvent({ kind: "proposal", payload: { kind: "change-cell", id: proposal.id, state: proposal.state } });
        return { id: proposal.id, state: proposal.state };
      }),
    tool("propose_execution", "Prepare a user confirmation for exact cell execution. Never admits or runs execution.",
      object({ notebookId: uuid, cellId: { type: "string" }, revision: { type: "integer", minimum: 1 }, inputs: { type: "array", items: object({ id: uuid, name: { type: "string" }, sha256: { type: "string" } }, ["id", "name", "sha256"]), maxItems: 32 } }, ["notebookId", "cellId", "revision", "inputs"]),
      async (args, signal) => {
        signal.throwIfAborted();
        const confirmation = await scope.confirmations.prepareExecution(scope.actor, scope.projectId, args);
        await scope.onEvent({ kind: "proposal", payload: { kind: "execution", id: confirmation.id } });
        return { id: confirmation.id, fingerprint: confirmation.fingerprint, expiresAt: confirmation.expiresAt, pending: true };
      }),
  ].sort((a, b) => a.name.localeCompare(b.name));
}
