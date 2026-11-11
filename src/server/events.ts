import { randomUUID } from "node:crypto";

export type DiagnosticComponent =
  | "socket"
  | "role"
  | "lease"
  | "cli"
  | "auth"
  | "docker"
  | "image"
  | "operation";
export type DiagnosticStatus = "ready" | "blocked" | "unknown";
export interface DiagnosticEvent {
  id: string;
  timestamp: string;
  component: DiagnosticComponent;
  status: DiagnosticStatus;
  code: string;
  action: string;
}
const actions: Record<DiagnosticComponent, string> = {
  socket:
    "Start the owned PostgreSQL database and check its private Unix socket.",
  role: "Apply the approved migrations; do not use an elevated application role.",
  lease: "Check the single writer and recovery status before retrying.",
  cli: "Install the supported GitHub Copilot CLI and check its executable.",
  auth: "Authenticate using the Copilot CLI outside the browser.",
  docker:
    "Start Docker and check access without changing other users' resources.",
  image:
    "Build and verify the configured pinned runtime image; do not pull implicitly.",
  operation:
    "Check readiness and retry only with a fresh required confirmation.",
};
/** @id CODE-DIAG-EVENTS @implements REQ-DIAG-001 */
export class DiagnosticEvents {
  constructor(
    private readonly sink: (event: DiagnosticEvent) => void = (event) =>
      console.error(JSON.stringify(event)),
  ) {}
  record(component: DiagnosticComponent, status: DiagnosticStatus) {
    const event: DiagnosticEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      component,
      status,
      code: `${component.toUpperCase()}_${status.toUpperCase()}`,
      action: actions[component],
    };
    this.sink({ ...event });
    return event;
  }
  failure() {
    return this.record("operation", "blocked");
  }
}
