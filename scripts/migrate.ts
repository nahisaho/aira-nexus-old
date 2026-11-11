import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connectDatabase } from "../src/server/database";
import { loadCredentials, type Credentials } from "../src/server/credentials";
import { ServiceError } from "../src/server/http";

/** @id CODE-OPS-MIGRATE @implements REQ-OPS-003 REQ-NH-002 REQ-NOTE-005 */
export async function migrate(state: string, credentials: Credentials) {
  const bootstrap = await connectDatabase(state, credentials, "bootstrap");
  try {
    await bootstrap.query("BEGIN");
    await bootstrap.query("SELECT pg_advisory_xact_lock(918273644)");
    const existing = await bootstrap.query(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('aira_migration','aira_application')",
    );
    if (existing.rowCount === 0) {
      if (
        (
          await bootstrap.query(
            "SELECT to_regclass('public.writer_control') AS relation",
          )
        ).rows[0].relation !== null
      ) {
        throw new ServiceError(
          503,
          "EXISTING_SCHEMA_REQUIRES_EXPLICIT_RECOVERY",
        );
      }
      // Passwords are validated hex; PostgreSQL does not accept parameters in CREATE ROLE.
      await bootstrap.query(
        `CREATE ROLE aira_migration LOGIN PASSWORD '${credentials.migration}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      await bootstrap.query(
        `CREATE ROLE aira_application LOGIN PASSWORD '${credentials.application}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      await bootstrap.query("REVOKE ALL ON DATABASE aira FROM PUBLIC");
      await bootstrap.query(
        "GRANT CONNECT ON DATABASE aira TO aira_migration, aira_application",
      );
      await bootstrap.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await bootstrap.query(
        "GRANT USAGE, CREATE ON SCHEMA public TO aira_migration",
      );
      await bootstrap.query("GRANT USAGE ON SCHEMA public TO aira_application");
    } else if (existing.rowCount !== 2) {
      throw new ServiceError(503, "PARTIAL_DATABASE_ROLES");
    }
    await bootstrap.query("COMMIT");
  } catch (error) {
    await bootstrap.query("ROLLBACK");
    throw error;
  } finally {
    await bootstrap.end();
  }
  const client = await connectDatabase(state, credentials, "migration");
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(918273644)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
    );
    for (const name of [
      "001-operations",
      "002-project-chat",
      "002-project-jobs",
      "003-files",
      "004-provenance",
      "005-notebooks",
      "006-proposals",
      "007-checks",
      "008-runtime",
      "009-exchange",
      "010-project-visibility",
      "011-integration-catalog",
      "012-project-navigation",
      "013-notebook-history",
      "014-project-lab-note",
    ]) {
      const applied = await client.query(
        "SELECT name FROM schema_migrations WHERE name=$1",
        [name],
      );
      if (applied.rowCount !== 0) continue;
      if (name === "013-notebook-history" || name === "014-project-lab-note") {
        const writer = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock(918273645) AS locked",
        );
        if (!writer.rows[0].locked)
          throw new ServiceError(
            409,
            name === "013-notebook-history"
              ? "NOTEBOOK_HISTORY_REQUIRES_QUIESCENT_WRITER"
              : "PROJECT_LAB_NOTE_REQUIRES_QUIESCENT_WRITER",
          );
      }
      await client.query(
        await readFile(
          join(process.cwd(), `src/server/migrations/${name}.sql`),
          "utf8",
        ),
      );
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [
        name,
      ]);
      if (name === "001-operations")
        await client.query(
          "GRANT SELECT, INSERT, UPDATE, DELETE ON writer_control, jobs, grants, operation_containers TO aira_application",
        );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const state = resolve(process.env.AIRA_STATE_DIR ?? ".aira");
  try {
    await migrate(state, await loadCredentials(state));
    console.log("Database migrations applied.");
  } catch {
    console.error("DATABASE_MIGRATION_FAILED");
    process.exitCode = 1;
  }
}
