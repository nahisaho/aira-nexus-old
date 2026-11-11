import next from "next";
import { createServer } from "node:http";
import {
  createApplication,
  installApplication,
} from "../../src/server/application";
import type { CopilotPort } from "../../src/server/copilot";
const copilot: CopilotPort = {
  async reply(input) {
    await input.onStarted?.();
    const text =
      "Controlled science response $E=mc^2$ <script>globalThis.__airaXss=1</script>";
    await input.onText(text);
    return text;
  },
};
const application = await createApplication({
  state: process.argv[2],
  copilot,
  auth: async () => ({ isAuthenticated: true }),
});
installApplication(application);
const app = next({
  dev: process.argv[3] !== "production",
  hostname: "127.0.0.1",
});
await app.prepare();
const server = createServer(app.getRequestHandler());
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("WORKSPACE_ADDRESS");
console.log(`AIRA_WORKSPACE_READY http://127.0.0.1:${address.port}`);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  await app.close();
  await application.close();
}
process.once("SIGTERM", () => {
  void close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
});
