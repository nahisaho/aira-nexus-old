import type { Credentials } from "./credentials";
import type { Operations } from "./operations";
import { DiagnosticEvents, type DiagnosticEvent } from "./events";
import { privateDirectory } from "./credentials";
import { connectDatabase } from "./database";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ServiceError } from "./http";

const exec = promisify(execFile);

export interface DiagnosticOptions {
  cli?: string;
  imageDigest: string;
  auth: () => Promise<{ isAuthenticated: boolean }>;
  events?: DiagnosticEvents;
}
export interface Readiness {
  ready: boolean;
  events: DiagnosticEvent[];
}
/** @id CODE-DIAG-READINESS @implements REQ-DIAG-001 */
export class Diagnostics {
  constructor(
    readonly state: string,
    readonly credentials: Credentials,
    readonly operations: Operations | undefined,
    readonly options: DiagnosticOptions,
  ) {}
  async readiness(): Promise<Readiness> {
    const recorder = this.options.events ?? new DiagnosticEvents();
    const events: DiagnosticEvent[] = [];
    async function probe(
      component: DiagnosticEvent["component"],
      run: () => Promise<boolean>,
    ) {
      try {
        events.push(
          recorder.record(component, (await run()) ? "ready" : "blocked"),
        );
      } catch {
        // Probe errors can contain credentials or research text; emit only fixed facts.
        events.push(recorder.record(component, "unknown"));
      }
    }
    await probe("socket", async () => {
      await privateDirectory(join(this.state, "socket"));
      const socket = await lstat(join(this.state, "socket", ".s.PGSQL.5432"));
      if (!socket.isSocket() || socket.uid !== process.getuid?.()) return false;
      const client = await connectDatabase(
        this.state,
        this.credentials,
        "application",
      );
      try {
        await client.query("SELECT 1");
        return true;
      } finally {
        await client.end();
      }
    });
    await probe("role", async () => {
      const client = await connectDatabase(
        this.state,
        this.credentials,
        "application",
      );
      try {
        const result = await client.query<{ safe: boolean }>(`
          SELECT current_user='aira_application'
            AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
            AND NOT has_schema_privilege(current_user,'public','CREATE')
            AND has_table_privilege(current_user,'public.writer_control','SELECT')
            AND NOT EXISTS(SELECT 1 FROM pg_roles p WHERE p.oid<>r.oid
              AND pg_has_role(current_user,p.oid,'MEMBER')) AS safe
          FROM pg_roles r WHERE rolname=current_user`);
        return result.rows[0]?.safe === true;
      } finally {
        await client.end();
      }
    });
    if (!this.operations) events.push(recorder.record("lease", "unknown"));
    else {
      try {
        await this.operations.write(async (client) => {
          await client.query("SELECT 1");
        });
        events.push(recorder.record("lease", "ready"));
      } catch (error) {
        const lost =
          error instanceof ServiceError &&
          ["WRITER_LEASE_UNAVAILABLE", "WRITER_FENCE_REJECTED"].includes(
            error.code,
          );
        events.push(recorder.record("lease", lost ? "blocked" : "unknown"));
      }
    }
    await probe("cli", async () => {
      const result = await exec(this.options.cli ?? "copilot", ["--version"], {
        timeout: 10000,
        maxBuffer: 16384,
      });
      return /\bGitHub Copilot CLI \d+\.\d+\.\d+\b/.test(result.stdout);
    });
    await probe(
      "auth",
      async () => (await this.options.auth()).isAuthenticated === true,
    );
    await probe("docker", async () => {
      const result = await exec(
        "docker",
        ["info", "--format", "{{.ServerVersion}}"],
        {
          timeout: 10000,
          maxBuffer: 16384,
        },
      );
      return /^\d+\.\d+/.test(result.stdout.trim());
    });
    await probe("image", async () => {
      if (!/^sha256:[a-f0-9]{64}$/.test(this.options.imageDigest)) return false;
      const result = await exec(
        "docker",
        ["image", "inspect", "--format", "{{.Id}}", this.options.imageDigest],
        {
          timeout: 10000,
          maxBuffer: 16384,
        },
      );
      return result.stdout.trim() === this.options.imageDigest;
    });
    return { ready: events.every((event) => event.status === "ready"), events };
  }
}
