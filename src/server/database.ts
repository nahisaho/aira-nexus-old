import pg from "pg";
import type { Credentials } from "./credentials";
import { join } from "node:path";

export type DatabaseRole = "bootstrap" | "migration" | "application";
const users: Record<DatabaseRole, string> = {
  bootstrap: "aira_bootstrap",
  migration: "aira_migration",
  application: "aira_application",
};

export function databaseConfig(
  state: string,
  credentials: Credentials,
  role: DatabaseRole,
): pg.ClientConfig {
  return {
    host: join(state, "socket"),
    port: 5432,
    user: users[role],
    password: credentials[role],
    database: "aira",
    connectionTimeoutMillis: 3000,
    statement_timeout: 15000,
    application_name: `aira-${role}`,
  };
}

export async function connectDatabase(
  state: string,
  credentials: Credentials,
  role: DatabaseRole,
) {
  const client = new pg.Client(databaseConfig(state, credentials, role));
  client.on("error", () => {
    console.error("DATABASE_CONNECTION_LOST");
  });
  await client.connect();
  return client;
}
