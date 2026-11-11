import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ServiceError } from "./http";

const exec = promisify(execFile);

export async function docker(args: string[]) {
  try {
    const { stdout } = await exec("docker", args, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    // Docker output may contain credential-bearing configuration.
    throw new ServiceError(503, "CONTAINER_COMMAND_FAILED");
  }
}

export interface ContainerIdentity {
  id: string;
  applicationId: string;
  controlId: string;
  resourceId: string;
}

export interface Inspection {
  Id: string;
  Image: string;
  Config: { Labels: Record<string, string>; User: string; Image: string };
  State: { Running: boolean; Pid: number; Status: string };
  HostConfig: {
    NetworkMode: string;
    ReadonlyRootfs: boolean;
    Memory: number;
    NanoCpus: number;
    PidsLimit: number;
    CapDrop: string[];
    CapAdd: string[] | null;
    Privileged: boolean;
    Devices: unknown[];
    DeviceRequests: unknown[] | null;
    Tmpfs: Record<string, string>;
    SecurityOpt: string[];
    PortBindings: Record<string, unknown> | null;
  };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
}

/** @id CODE-OPS-OWNERSHIP @implements REQ-OPS-003 */
export async function inspectOwned(
  identity: ContainerIdentity,
): Promise<Inspection> {
  if (!/^[a-f0-9]{64}$/.test(identity.id))
    throw new ServiceError(503, "INVALID_CONTAINER_ID");
  const [value] = JSON.parse(
    await docker(["inspect", identity.id]),
  ) as Inspection[];
  const labels = value?.Config.Labels;
  if (
    !value ||
    value.Id !== identity.id ||
    labels?.["aira.application"] !== identity.applicationId ||
    labels?.["aira.control"] !== identity.controlId ||
    labels?.["aira.resource"] !== identity.resourceId
  ) {
    throw new ServiceError(503, "CONTAINER_OWNERSHIP_UNCERTAIN");
  }
  return value;
}

export async function stopOwned(identity: ContainerIdentity) {
  const inspected = await inspectOwned(identity);
  if (inspected.State.Running)
    await docker(["stop", "--time", "5", identity.id]);
  if ((await inspectOwned(identity)).State.Running) {
    throw new ServiceError(503, "CONTAINER_STOP_UNCONFIRMED");
  }
}

export async function removeOwned(identity: ContainerIdentity) {
  await stopOwned(identity);
  await docker(["rm", identity.id]);
}
