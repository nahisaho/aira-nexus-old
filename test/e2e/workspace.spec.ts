import { expect, test } from "@playwright/test";
import {
  workspaceFixture,
  projectFlow,
  confirmationFlow,
  safetyFlow,
} from "../helpers/workspace";
test("built Next workspace with real database, exact confirmations, inert text and math worker", async () => {
  const f = await workspaceFixture(true);
  try {
    await projectFlow(f);
    // The project flow ends at mobile width; the next flows use desktop panes.
    await f.page.setViewportSize({ width: 1100, height: 900 });
    await expect(f.page.locator("#explorer-pane")).toBeVisible();
    await confirmationFlow(f);
    await safetyFlow(f);
  } finally {
    await f.close();
  }
});
