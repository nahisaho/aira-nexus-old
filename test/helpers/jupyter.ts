import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { z } from "zod";
import type { Credentials } from "../../src/server/credentials";
import { docker, removeOwned, type ContainerIdentity } from "../../src/server/owned-containers";
const driver = `
import json, sys, time, subprocess
from queue import Empty
import nbformat
from jupyter_client import KernelManager
document = nbformat.reads(sys.stdin.read(), as_version=4)
nbformat.validate(document)
manager = KernelManager(kernel_name="python3")
manager.start_kernel(cwd="/workspace", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
client = manager.client()
failed = False
try:
 client.start_channels()
 client.wait_for_ready(timeout=30)
 for cell in document.cells:
  if cell.cell_type != "code":
   continue
  cell.outputs = []
  identifier = client.execute(cell.source, stop_on_error=True)
  deadline = time.monotonic() + 30
  while True:
   if time.monotonic() >= deadline:
    raise TimeoutError("EXTERNAL_JUPYTER_IOPUB_TIMEOUT")
   try:
    message = client.get_iopub_msg(timeout=1)
   except Empty:
    continue
   if message.get("parent_header", {}).get("msg_id") != identifier:
    continue
   kind, content = message["msg_type"], message["content"]
   if kind == "status" and content["execution_state"] == "idle":
    break
   if kind == "execute_input":
    cell.execution_count = content["execution_count"]
   if kind in ("stream", "error", "display_data", "execute_result"):
    keys = {"stream": ("name", "text"), "error": ("ename", "evalue", "traceback"), "display_data": ("data", "metadata"), "execute_result": ("data", "metadata", "execution_count")}[kind]
    cell.outputs.append(nbformat.from_dict(dict(output_type=kind, **{key: content[key] for key in keys})))
  while True:
   if time.monotonic() >= deadline:
    raise TimeoutError("EXTERNAL_JUPYTER_SHELL_TIMEOUT")
   try:
    reply = client.get_shell_msg(timeout=1)
   except Empty:
    continue
   if reply.get("parent_header", {}).get("msg_id") == identifier:
    failed = reply["content"]["status"] != "ok" or any(output.output_type == "error" for output in cell.outputs)
    break
  if failed:
   break
 nbformat.validate(document)
 print(json.dumps({"failed": failed, "document": document}, allow_nan=False))
finally:
 client.stop_channels()
 manager.shutdown_kernel(now=True)
`;
export async function externalNotebook(raw: Buffer, credentials: Credentials, created?: (identity: ContainerIdentity) => void) {
  const resourceId = randomUUID();
  const id = await docker([
    "create", "-i", "--pull=never", "--network=none", "--read-only",
    "--user=1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--memory=2g", "--cpus=1", "--pids-limit=128",
    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000",
    "--tmpfs=/workspace:rw,nosuid,nodev,noexec,size=512m,uid=1000,gid=1000",
    "--env=HOME=/tmp", "--env=JUPYTER_RUNTIME_DIR=/tmp/jupyter",
    "--env=IPYTHONDIR=/tmp/ipython", "--env=MPLCONFIGDIR=/tmp/matplotlib",
    "--env=OPENBLAS_NUM_THREADS=1", "--env=OMP_NUM_THREADS=1",
    "--label", `aira.application=${credentials.applicationId}`,
    "--label", `aira.control=${credentials.controlId}`,
    "--label", `aira.resource=${resourceId}`,
    "--entrypoint=python", "aira-nexus-runtime:0.1", "-u", "-c", driver,
  ]);
  const identity = { id, resourceId, applicationId: credentials.applicationId, controlId: credentials.controlId };
  try {
    created?.(identity);
    const text = await new Promise<string>((resolve, reject) => {
      const child = execFile("docker", ["start", "-ai", id], { encoding: "utf8", timeout: 90000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin?.on("error", reject);
      child.stdin?.end(raw);
    });
    const result = z.object({ failed: z.boolean(), document: z.json() }).strict().parse(JSON.parse(text));
    return { failed: result.failed, body: Buffer.from(JSON.stringify(result.document)), identity };
  } finally { await removeOwned(identity); }
}
