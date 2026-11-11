import { test } from "node:test";
import {
  initializationShutdown,
  startupSignalShutdown,
} from "./helpers/workspace-lifecycle";
import {
  workspaceFixture,
  projectFlow,
  confirmationFlow,
  safetyFlow,
} from "./helpers/workspace";
/** @id TEST-UI-001 @verifies REQ-UI-001 */
test(
  "TEST-UI-001 real DB single-chat persistence, project scope and mobile workspace",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture();
    t.after(() => f.close());
    await projectFlow(f);
  },
);
/** @id TEST-UI-002 @verifies REQ-UI-002 */
test(
  "TEST-UI-002 exact AI accept/reject, real execution/input versions/stale/lost-state and bounded outbound confirmation",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture();
    t.after(() => f.close());
    await confirmationFlow(f);
  },
);
/** @id TEST-UI-003 @verifies REQ-UI-003 */
test(
  "TEST-UI-003 inert text/actual Next math, visible409/imported/check scope and archived read-only controls",
  { timeout: 180000 },
  async (t) => {
    const f = await workspaceFixture();
    t.after(() => f.close());
    await safetyFlow(f);
    await initializationShutdown();
    await startupSignalShutdown();
  },
);
