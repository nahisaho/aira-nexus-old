import { z } from "zod";
import type { Job } from "./operations";
export interface SharedVariable {
  name: string;
  direction: "python-to-r" | "r-to-python";
  family?: "scalar" | "array" | "table";
}
export interface RunEnvironment {
  imageDigest: string;
  python: string | null;
  r: string | null;
  packages: Record<string, string | null>;
}
export interface CaptureInput {
  jobId: string;
  notebookId: string;
  cellId: string;
  revision: number;
  source: string;
  language: "python" | "r";
  sharing: SharedVariable[];
  inputs: { id: string; name: string }[];
  kernelEpoch: string;
  environment: RunEnvironment | null;
}
export type RunOutput =
  | { output_type: "stream"; name: "stdout" | "stderr"; text: string }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] }
  | {
      output_type: "display_data";
      data: Record<string, unknown>;
      metadata: Record<string, unknown>;
    }
  | {
      output_type: "execute_result";
      data: Record<string, unknown>;
      metadata: Record<string, unknown>;
      execution_count: number | null;
    };
export function plainRunText(outputs: readonly RunOutput[]): string {
  return outputs
    .map((output) => {
      if (output.output_type === "stream") return output.text;
      if (output.output_type === "error")
        return [output.ename + ": " + output.evalue, ...output.traceback].join(
          "\n",
        );
      const plain = output.data["text/plain"];
      return typeof plain === "string" ? plain : "";
    })
    .join("");
}
export interface CapturedRun extends Omit<CaptureInput, "inputs"> {
  id: string;
  actor: string;
  projectId: string;
  chatId: string;
  sequence: string;
  inputs: { id: string; workspaceName: string; size: number; sha256: string }[];
  createdAt: string;
  dispatchedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  status: Job["state"];
  outputs: RunOutput[] | null;
}
export interface CurrentCell {
  id: string;
  revision: number;
  source: string;
  language: "python" | "r";
  sharing: SharedVariable[];
  kernelEpoch: string | null;
}
export const sharingSchema = z
  .array(
    z
      .object({
        name: z.string().min(1).max(120),
        direction: z.enum(["python-to-r", "r-to-python"]),
        family: z.enum(["scalar", "array", "table"]).optional(),
      })
      .strict(),
  )
  .refine(
    (entries) =>
      new Set(entries.map((e) => `${e.direction}:${e.name}`)).size ===
      entries.length,
  );
export const cellIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const captureSchema = z
  .object({
    jobId: z.uuid(),
    notebookId: z.uuid(),
    cellId: cellIdSchema,
    revision: z.number().int().positive(),
    source: z.string().refine((s) => Buffer.byteLength(s) <= 65536),
    language: z.enum(["python", "r"]),
    sharing: sharingSchema,
    inputs: z.array(z.object({ id: z.uuid(), name: z.string() }).strict()),
    kernelEpoch: z.uuid(),
    environment: z
      .object({
        imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        python: z.string().nullable(),
        r: z.string().nullable(),
        packages: z.record(z.string(), z.string().nullable()),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const outputsSchema = z.array(
  z.discriminatedUnion("output_type", [
    z
      .object({
        output_type: z.literal("stream"),
        name: z.enum(["stdout", "stderr"]),
        text: z.string(),
      })
      .strict(),
    z
      .object({
        output_type: z.literal("error"),
        ename: z.string(),
        evalue: z.string(),
        traceback: z.array(z.string()),
      })
      .strict(),
    z
      .object({
        output_type: z.literal("display_data"),
        data: z.record(z.string(), z.json()),
        metadata: z.record(z.string(), z.json()),
      })
      .strict(),
    z
      .object({
        output_type: z.literal("execute_result"),
        data: z.record(z.string(), z.json()),
        metadata: z.record(z.string(), z.json()),
        execution_count: z.number().int().nonnegative().nullable(),
      })
      .strict(),
  ]),
);
/** @id CODE-PROV-PROJECTION @implements REQ-PROV-003 */
export function projectRun(
  run: CapturedRun,
  cell: CurrentCell,
): {
  stale: boolean;
  lostState: boolean;
  historicalOutputs: RunOutput[] | null;
  currentOutputs: RunOutput[];
} {
  const stale =
    run.cellId !== cell.id ||
    run.revision !== cell.revision ||
    run.source !== cell.source ||
    run.language !== cell.language ||
    run.sharing.length !== cell.sharing.length ||
    run.sharing.some(
      (entry, i) =>
        entry.name !== cell.sharing[i].name ||
        entry.direction !== cell.sharing[i].direction ||
        entry.family !== cell.sharing[i].family,
    );
  return {
    stale,
    lostState:
      run.kernelEpoch !== cell.kernelEpoch || run.status === "interrupted",
    historicalOutputs: run.outputs,
    currentOutputs: stale ? [] : (run.outputs ?? []),
  };
}
