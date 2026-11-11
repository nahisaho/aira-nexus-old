import { Worker, type WorkerOptions } from "node:worker_threads";
import { z } from "zod";
import { ServiceError } from "./http";
import { projectId as validId } from "./project-scope";
export interface RenderingError {
  kind: string;
  message: string;
}
export interface ScientificView {
  raw: string;
  html: string;
  omittedBytes: number;
  errors: RenderingError[];
}
export type MathWorkerFactory = (
  data: { source: string; projectId?: string },
  options: WorkerOptions,
) => Worker;
const resultSchema = z
  .object({
    html: z.string(),
    errors: z.array(
      z.object({ kind: z.string(), message: z.string() }).strict(),
    ),
  })
  .strict();
function escape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
/** @id CODE-RENDER-SERVICE @implements REQ-RENDER-001 REQ-RENDER-002 REQ-RENDER-003 */
export async function renderScientific(
  source: string,
  options: { projectId?: string; createWorker?: MathWorkerFactory } = {},
): Promise<ScientificView> {
  if (typeof source !== "string" || /[\uD800-\uDFFF]/u.test(source))
    throw new ServiceError(400, "INVALID_SCIENTIFIC_TEXT");
  if (options.projectId !== undefined) validId(options.projectId);
  const bytes = Buffer.from(source);
  const preview = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    bytes.subarray(0, 65536),
    { stream: true },
  );
  const omittedBytes = bytes.length - Buffer.byteLength(preview);
  function fallback(kind: string, message: string) {
    return {
      html: `<p class="rendering-error" role="alert">Rendering error: ${escape(message)}</p><pre>${escape(preview)}</pre>`,
      errors: [{ kind, message }],
    };
  }
  const createWorker: MathWorkerFactory =
    options.createWorker ??
    ((data, settings) =>
      new Worker(new URL("./math-worker.ts", import.meta.url), {
        ...settings,
        workerData: data,
      }));
  let worker: Worker;
  try {
    worker = createWorker(
      { source: preview, projectId: options.projectId?.toLowerCase() },
      {
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      },
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return {
      ...fallback("worker_error", "Scientific renderer could not start"),
      raw: source,
      omittedBytes,
    };
  }
  return new Promise<ScientificView>((resolve, reject) => {
    let settled = false;
    const deadline = setTimeout(() => {
      void finish(
        fallback("timeout", "Rendering exceeded the one-second worker budget"),
      );
    }, 1000);
    async function finish(
      result: z.infer<typeof resultSchema> | null,
      failure?: unknown,
    ) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        await worker.terminate();
        if (worker.threadId !== -1)
          throw new ServiceError(503, "RENDERER_CLEANUP_UNCERTAIN");
        if (result === null) reject(failure);
        else resolve({ ...result, raw: source, omittedBytes });
      } catch (error) {
        reject(error);
      }
    }
    worker.once("message", (value: unknown) => {
      if (!(value instanceof Uint8Array)) {
        void finish(
          fallback("worker_error", "Renderer returned invalid output"),
        );
        return;
      }
      if (value.byteLength > 1024 ** 2 || value.buffer.byteLength > 1024 ** 2) {
        void finish(fallback("output_limit", "Rendered output exceeded 1 MiB"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(value),
        );
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof TypeError)) {
          void finish(null, error);
          return;
        }
        void finish(
          fallback("worker_error", "Renderer returned invalid output"),
        );
        return;
      }
      const result = resultSchema.safeParse(parsed);
      void finish(
        result.success
          ? result.data
          : fallback("worker_error", "Renderer returned invalid output"),
      );
    });
    worker.once("error", () => {
      void finish(fallback("worker_error", "Scientific renderer failed"));
    });
    worker.once("exit", () => {
      void finish(fallback("worker_error", "Renderer exited without a result"));
    });
  });
}
