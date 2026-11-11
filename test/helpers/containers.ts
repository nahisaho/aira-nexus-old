import { randomUUID } from "node:crypto";
import type { Credentials } from "../../src/server/credentials";
import {
  docker,
  removeOwned,
  type ContainerIdentity,
} from "../../src/server/owned-containers";

export async function testContainer(
  credentials: Credentials,
  resourceId: string = randomUUID(),
): Promise<ContainerIdentity> {
  const id = await docker([
    "create",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory=32m",
    "--pids-limit=16",
    "--entrypoint=python",
    "--label",
    `aira.application=${credentials.applicationId}`,
    "--label",
    `aira.control=${credentials.controlId}`,
    "--label",
    `aira.resource=${resourceId}`,
    "aira-nexus-runtime:0.1",
    "-c",
    "import signal; signal.pause()",
  ]);
  const identity = {
    id,
    applicationId: credentials.applicationId,
    controlId: credentials.controlId,
    resourceId,
  };
  try {
    await docker(["start", id]);
    return identity;
  } catch (error) {
    await removeOwned(identity);
    throw error;
  }
}
