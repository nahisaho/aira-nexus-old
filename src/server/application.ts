import { Copilot, type CopilotPort } from "./copilot";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { loadCredentials } from "./credentials";
import { Operations } from "./operations";
import { Sessions } from "./sessions";
import { Projects } from "./projects";
import { IntegrationCatalog } from "./integration-catalog";
import { FileStorage, storageDirectory } from "./file-storage";
import { Files } from "./files";
import { Provenance } from "./provenance";
import { Runtime } from "./runtime";
import { Notebooks } from "./notebooks";
import { Confirmations } from "./confirmations";
import { Proposals } from "./proposals";
import { Chat } from "./chat";
import { Sources } from "./sources";
import { Exchange } from "./exchange";
import { ResearchChecks } from "./research-checks";
import { Diagnostics } from "./diagnostics";
import { DiagnosticEvents } from "./events";
import { renderScientific } from "./scientific-rendering";
import { projectRoutes } from "./project-routes";
import { integrationRoutes } from "./integration-routes";
import { chatRoutes } from "./chat-routes";
import { fileRoutes } from "./file-routes";
import { notebookRoutes } from "./notebook-routes";
import { proposalRoutes } from "./proposal-routes";
import { sourceRoutes } from "./source-routes";
import { exchangeRoutes } from "./exchange-routes";
import { checkRoutes } from "./check-routes";
import { diagnosticRoutes } from "./diagnostic-routes";
import { localResponse, readJson, assertLocalRequest } from "./local-boundary";
import { ServiceError } from "./http";
export const RUNTIME_IMAGE =
  "sha256:ca17b3e0cfba612f32a53005f2aaa7cdc5b8fb3bd2c13e86edae7b41de3c148a";
export interface Application {
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}
export interface ApplicationOptions {
  state: string;
  copilot?: CopilotPort;
  auth?: () => Promise<{ isAuthenticated: boolean }>;
}
declare global {
  var airaNexusApplication: Promise<Application> | undefined;
}
export function installApplication(application: Application) {
  globalThis.airaNexusApplication = Promise.resolve(application);
}
export function getApplication() {
  return (globalThis.airaNexusApplication ??= createApplication({
    state: process.env.AIRA_STATE_DIR ?? ".aira",
  }).catch((error) => {
    globalThis.airaNexusApplication = undefined;
    throw error;
  }));
}
async function cliExecutable() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, "copilot");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
      ))
        throw error;
    }
  }
}
/** @id CODE-UI-APPLICATION @implements REQ-UI-001 REQ-UI-002 REQ-UI-003 */
export async function createApplication(
  options: ApplicationOptions,
): Promise<Application> {
  const state = resolve(options.state),
    credentials = await loadCredentials(state);
  const events = new DiagnosticEvents();
  const operations = new Operations(state, credentials);
  const cleanup: (() => Promise<unknown>)[] = [() => operations.shutdown()];
  try {
    await operations.acquire();
    const storage = new FileStorage(await storageDirectory(state));
    await storage.initialize();
    const files = new Files(operations, storage, state, credentials);
    cleanup.push(() => files.close());
    const provenance = new Provenance(operations, files, state, credentials);
    cleanup.push(() => provenance.close());
    const runtime = new Runtime(
      operations,
      files,
      provenance,
      state,
      credentials,
      RUNTIME_IMAGE,
    );
    cleanup.push(() => runtime.close());
    const notebooks = new Notebooks(
      operations,
      provenance,
      runtime,
      state,
      credentials,
    );
    cleanup.push(() => notebooks.close());
    await notebooks.versions.start();
    const confirmations = new Confirmations(
      operations,
      notebooks,
      files,
      provenance,
      state,
      credentials,
      { imageDigest: RUNTIME_IMAGE },
    );
    cleanup.push(() => confirmations.close());
    const sources = new Sources(files, provenance, confirmations);
    const sessions = new Sessions(
      operations,
      state,
      credentials,
      sources.resolver,
    );
    cleanup.push(() => sessions.close());
    const projects = new Projects(operations, sessions, state, credentials);
    cleanup.push(() => projects.close());
    const integrations = new IntegrationCatalog(operations, state, credentials);
    cleanup.push(() => integrations.close());
    const proposals = new Proposals(operations, notebooks, state, credentials);
    cleanup.push(() => proposals.close());
    const executable = await cliExecutable();
    const copilot =
      options.copilot ??
      (executable
        ? new Copilot({ executable, state })
        : {
            async reply(): Promise<string> {
              throw new ServiceError(503, "COPILOT_CLI_UNAVAILABLE");
            },
          });
    const chat = new Chat({
      operations,
      sessions,
      files,
      provenance,
      proposals,
      confirmations,
      copilot,
    });
    const checks = new ResearchChecks(
      { operations, sessions, files, notebooks, sources },
      state,
      credentials,
    );
    cleanup.push(() => checks.close());
    const exchange = new Exchange(notebooks);
    const auth =
      options.auth ??
      (async () => {
        if (!executable) throw new ServiceError(503, "COPILOT_CLI_UNAVAILABLE");
        const client = new CopilotClient({
          connection: RuntimeConnection.forStdio({ path: executable }),
          mode: "empty",
          useLoggedInUser: true,
          logLevel: "none",
        });
        try {
          return await client.getAuthStatus();
        } finally {
          const errors = await client.stop();
          if (errors.length) {
            await client.forceStop();
            throw new ServiceError(503, "COPILOT_AUTH_CLEANUP_UNCERTAIN");
          }
        }
      });
    const diagnostics = new Diagnostics(state, credentials, operations, {
      imageDigest: RUNTIME_IMAGE,
      auth,
      events,
      cli: executable,
    });
    const routes: [RegExp, (request: Request) => Promise<Response>][] = [
      [/^\/api\/readiness$/, diagnosticRoutes(diagnostics)],
      [/^\/api\/integrations$/, integrationRoutes(integrations)],
      [
        /^\/api\/projects\/[^/]+\/integrations$/,
        integrationRoutes(integrations),
      ],
      [/^\/api\/projects\/[^/]+\/chat(?:\/|$)/, chatRoutes(chat)],
      [/^\/api\/projects\/[^/]+\/files(?:\/|$)/, fileRoutes(files)],
      [
        /^\/api\/projects\/[^/]+\/(?:proposals|confirmations)(?:\/|$)/,
        proposalRoutes(proposals, confirmations),
      ],
      [/^\/api\/projects\/[^/]+\/sources\//, sourceRoutes(sources)],
      [/^\/api\/projects\/[^/]+\/checks(?:\/|$)/, checkRoutes(checks)],
      [
        /^\/api\/projects\/[^/]+\/notebooks\/(?:import$|[^/]+\/export$)/,
        exchangeRoutes(exchange),
      ],
      [/^\/api\/projects\/[^/]+\/notebooks(?:\/|$)/, notebookRoutes(notebooks)],
      [/^\/api\/projects\/[^/]+\/lab-note$/, notebookRoutes(notebooks)],
      [/^\/api\/projects(?:\/|$)/, projectRoutes(projects)],
    ];
    let runtimeInitialization: Promise<void> | undefined;
    async function initializeRuntime() {
      if (!runtimeInitialization)
        runtimeInitialization = runtime
          .initialize(notebooks, confirmations)
          .catch((error) => {
            runtimeInitialization = undefined;
            throw error;
          });
      await runtimeInitialization;
    }
    let closing = false,
      closed: Promise<void> | undefined;
    const pending = new Set<Promise<Response>>();
    async function dispatch(request: Request): Promise<Response> {
      try {
        if (closing) throw new ServiceError(503, "APPLICATION_STOPPING");
        const path = new URL(request.url).pathname;
        if (path === "/api/render") {
          assertLocalRequest(request);
          if (request.method !== "POST")
            throw new ServiceError(405, "METHOD_NOT_ALLOWED");
          const parsed = z
            .object({ source: z.string(), projectId: z.uuid().optional() })
            .strict()
            .safeParse(await readJson(request));
          if (!parsed.success)
            throw new ServiceError(400, "INVALID_RENDER_REQUEST");
          if (parsed.data.projectId)
            await projects.get("local", parsed.data.projectId);
          return localResponse(
            await renderScientific(parsed.data.source, {
              projectId: parsed.data.projectId,
              createWorker: (data, settings) =>
                new Worker(
                  pathToFileURL(resolve("src/server/math-worker.ts")),
                  { ...settings, workerData: data },
                ),
            }),
          );
        }
        const execution =
          /^\/api\/projects\/([^/]+)\/notebooks\/([^/]+)\/execute$/.exec(path);
        const kernel =
          /^\/api\/projects\/([^/]+)\/runtime\/([^/]+)(\/restart)?$/.exec(path);
        if (execution || kernel) {
          assertLocalRequest(request);
          const match = execution ?? kernel!;
          const project = await projects.get("local", match[1]);
          if (kernel && !kernel[3] && request.method === "GET")
            return localResponse(
              await runtime.status("local", project.id, match[2]),
            );
          if (request.method !== "POST")
            throw new ServiceError(405, "METHOD_NOT_ALLOWED");
          if (project.status !== "active")
            throw new ServiceError(409, "PROJECT_ARCHIVED");
          if (execution) {
            const parsed = z
              .object({
                confirmationId: z.uuid(),
                requestId: z.uuid(),
                fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict()
              .safeParse(await readJson(request));
            if (!parsed.success)
              throw new ServiceError(400, "INVALID_EXECUTION_REQUEST");
            const confirmation = await confirmations.get(
              "local",
              project.id,
              parsed.data.confirmationId,
            );
            if (
              confirmation.snapshot.kind !== "execution" ||
              confirmation.snapshot.notebookId !== match[2]
            )
              throw new ServiceError(409, "EXECUTION_SCOPE_CHANGED");
            await initializeRuntime();
            const result = await runtime.execute(
              "local",
              project.id,
              parsed.data,
            );
            return localResponse(result, result.status);
          }
          if (!kernel?.[3]) throw new ServiceError(405, "METHOD_NOT_ALLOWED");
          const parsed = z
            .object({ kernelEpoch: z.uuid() })
            .strict()
            .safeParse(await readJson(request));
          if (!parsed.success)
            throw new ServiceError(400, "INVALID_KERNEL_REQUEST");
          await runtime.restart(
            "local",
            project.id,
            match[2],
            parsed.data.kernelEpoch,
          );
          return localResponse({ restarted: true });
        }
        const route = routes.find(([pattern]) => pattern.test(path));
        if (!route) {
          assertLocalRequest(request);
          throw new ServiceError(404, "ROUTE_NOT_FOUND");
        }
        return await route[1](request);
      } catch (error) {
        if (error instanceof ServiceError)
          return localResponse({ code: error.code }, error.status);
        console.error("APPLICATION_REQUEST_FAILED");
        return localResponse({ code: "INTERNAL_ERROR" }, 500);
      }
    }
    return {
      async handle(request) {
        const result = dispatch(request);
        pending.add(result);
        try {
          const response = await result;
          if (response.status >= 400) events.failure();
          return response;
        } finally {
          pending.delete(result);
        }
      },
      close() {
        return (closed ??= (async () => {
          closing = true;
          const failures: unknown[] = [];
          if (runtimeInitialization) {
            const [initialized] = await Promise.allSettled([
              runtimeInitialization,
            ]);
            if (initialized.status === "rejected") {
              events.failure();
              console.error("RUNTIME_INITIALIZATION_FAILED_DURING_SHUTDOWN");
            }
          }
          try {
            await runtime.close();
          } catch (error) {
            failures.push(error);
          }
          await Promise.allSettled([...pending]);
          for (const close of cleanup.reverse()) {
            try {
              await close();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length)
            throw new AggregateError(failures, "APPLICATION_CLEANUP_FAILED");
        })());
      },
    };
  } catch (error) {
    const failures: unknown[] = [error];
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "APPLICATION_INITIALIZATION_CLEANUP_FAILED",
      );
    throw error;
  }
}
