import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { migrate } from "../../scripts/migrate";
import { startDatabase } from "../../src/server/db-container";
import { removeOwned } from "../../src/server/owned-containers";
import { privateDirectory } from "../../src/server/credentials";

export async function testDatabase() {
  const root = resolve(".scratch");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const state = await mkdtemp(join(root, "db-"));
  await privateDirectory(state);
  const database = await startDatabase(state, true);
  try {
    await migrate(state, database.credentials);
  } catch (error) {
    await removeOwned(database.identity);
    await rm(state, { recursive: true });
    throw error;
  }
  return {
    state,
    ...database,
    async cleanup() {
      await removeOwned(database.identity);
      await rm(state, { recursive: true });
    },
  };
}
