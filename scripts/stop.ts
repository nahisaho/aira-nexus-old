import { resolve } from "node:path";
import { loadCredentials } from "../src/server/credentials";
import { readDatabaseIdentity } from "../src/server/db-container";
import { connectDatabase } from "../src/server/database";
import { stopOwned } from "../src/server/owned-containers";
import { ServiceError } from "../src/server/http";

try {
  const state = resolve(process.env.AIRA_STATE_DIR ?? ".aira");
  const credentials = await loadCredentials(state);
  const client = await connectDatabase(state, credentials, "application");
  try {
    if (
      !(await client.query("SELECT pg_try_advisory_lock(918273645) AS locked"))
        .rows[0].locked
    ) {
      throw new ServiceError(409, "STOP_ACTIVE_APPLICATION_FIRST");
    }
    if (
      (
        await client.query(
          "SELECT id FROM operation_containers WHERE NOT stopped LIMIT 1",
        )
      ).rowCount
    ) {
      throw new ServiceError(409, "OPERATION_CLEANUP_REQUIRED");
    }
    await stopOwned(await readDatabaseIdentity(state, credentials));
  } finally {
    await client.end();
  }
  console.log("Owned database stopped; persistent state retained.");
} catch {
  console.error("DATABASE_STOP_FAILED");
  process.exitCode = 1;
}
