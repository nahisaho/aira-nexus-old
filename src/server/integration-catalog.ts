import pg from "pg";
import { z } from "zod";
import type { Operations } from "./operations";
import type { Credentials } from "./credentials";
import { ServiceError } from "./http";
import { databaseConfig } from "./database";
import { ownedProject } from "./project-scope";
import snapshot from "./co-scientist-catalog.json";

export interface IntegrationSelections {
  agents: string[];
  skills: string[];
  mcp: string[];
}
export interface IntegrationSettings {
  revision: number;
  selections: IntegrationSelections;
  appliedToChat: false;
}
export interface IntegrationEntry {
  id: string;
  name: string;
  path: string;
  gitBlob: string;
  reference?: string;
}
export interface IntegrationRegistry {
  schemaVersion: number;
  source: { repository: string; commit: string; root: string };
  agents: IntegrationEntry[];
  skills: IntegrationEntry[];
  mcp: IntegrationEntry[];
  appliedToChat: false;
}
const kinds = ["agents", "skills", "mcp"] as const;
const known = {
  agents: new Set<string>(),
  skills: new Set(snapshot.skills.map((entry) => entry.id)),
  mcp: new Set(snapshot.mcp.map((entry) => entry.id)),
};
const inputSchema = z
  .object({
    revision: z.number().int().min(1).max(2147483647),
    selections: z
      .object({
        agents: z.array(z.string()).max(0),
        skills: z.array(z.string()).max(snapshot.skills.length),
        mcp: z.array(z.string()).max(snapshot.mcp.length),
      })
      .strict(),
  })
  .strict();
function checked(input: unknown, stored = false) {
  const parsed = inputSchema.safeParse(input);
  if (
    !parsed.success ||
    kinds.some(
      (kind) =>
        new Set(parsed.data.selections[kind]).size !==
          parsed.data.selections[kind].length ||
        parsed.data.selections[kind].some((id) => !known[kind].has(id)),
    )
  )
    throw new ServiceError(
      stored ? 503 : 400,
      stored ? "INTEGRATION_SETTINGS_CORRUPT" : "INVALID_INTEGRATION_INPUT",
    );
  return parsed.data;
}

/** @id CODE-CAT-STORE @implements REQ-CAT-001 REQ-CAT-002 REQ-CAT-003 */
export class IntegrationCatalog {
  private readonly pool: pg.Pool;
  constructor(
    private readonly operations: Operations,
    state: string,
    credentials: Credentials,
  ) {
    this.pool = new pg.Pool({
      ...databaseConfig(state, credentials, "application"),
      max: 2,
    });
    this.pool.on("error", () =>
      console.error("INTEGRATION_DATABASE_CONNECTION_LOST"),
    );
  }
  registry(): IntegrationRegistry {
    return { ...structuredClone(snapshot), appliedToChat: false };
  }
  private async read(
    client: pg.Client | pg.Pool,
    actor: string,
    projectId: string,
  ): Promise<IntegrationSettings> {
    const result = await client.query<{
      revision: number;
      selections: unknown;
    }>(
      "SELECT revision,selections FROM project_integration_settings WHERE project_id=$1 AND actor=$2",
      [projectId, actor],
    );
    if (!result.rowCount)
      return {
        revision: 1,
        selections: { agents: [], skills: [], mcp: [] },
        appliedToChat: false,
      };
    return { ...checked(result.rows[0], true), appliedToChat: false };
  }
  async get(actor: string, projectId: string): Promise<IntegrationSettings> {
    await ownedProject(this.pool, actor, projectId);
    return this.read(this.pool, actor, projectId);
  }
  async save(
    actor: string,
    projectId: string,
    input: unknown,
  ): Promise<IntegrationSettings> {
    const value = checked(input);
    return this.operations.write(async (client) => {
      const project = await ownedProject(client, actor, projectId, true);
      if (project.status !== "active")
        throw new ServiceError(409, "PROJECT_ARCHIVED");
      const current = await this.read(client, actor, projectId);
      if (current.revision !== value.revision)
        throw new ServiceError(409, "STALE_INTEGRATION_REVISION");
      if (current.revision === 2147483647)
        throw new ServiceError(409, "INTEGRATION_REVISION_EXHAUSTED");
      await client.query(
        `INSERT INTO project_integration_settings(project_id,actor,revision,selections)
        VALUES($1,$2,$3,$4) ON CONFLICT(project_id) DO UPDATE
        SET revision=EXCLUDED.revision,selections=EXCLUDED.selections`,
        [
          projectId,
          actor,
          current.revision + 1,
          JSON.stringify(value.selections),
        ],
      );
      return {
        revision: current.revision + 1,
        selections: value.selections,
        appliedToChat: false,
      };
    });
  }
  async close() {
    await this.pool.end();
  }
}
