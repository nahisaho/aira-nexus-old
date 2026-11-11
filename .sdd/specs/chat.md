---
feature: chat
tier: T2
approval: human
---
# Copilot chat and artifacts
Goal: one persistent Copilot chat per project and generated files; human chat and other providers deferred.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-CHAT-001 | When a user submits a nonblank prompt of at most 16000 characters, the system shall persist the user message and the Copilot reply in the selected owned project's single chat. | TEST-CHAT-001 |
| REQ-CHAT-002 | If Copilot fails or exceeds 120 seconds, then the system shall persist a failed turn, return a visible 502 error, and never fabricate an assistant reply. | TEST-CHAT-002 |
| REQ-CHAT-003 | When the SDK requests a tool, the system shall permit only save_file, consented file excerpts, and proposal-only Notebook creation/edit/execution tools, denying host file, shell, arbitrary execution, network tools and ambient discovery. | TEST-CHAT-003 |
| REQ-CHAT-004 | When save_file supplies a safe basename and at most 1 MiB of UTF-8 text, the system shall persist an immutable project/chat artifact for safe preview and download; invalid names or larger tool arguments shall return an explicit error. | TEST-CHAT-004 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-CHAT-001` | project A history survives reload | project B has no A messages | TEST-CHAT-001 | unrun |
| `REQ-CHAT-002` | failed turn has error status | failure creates no success message | TEST-CHAT-002 | unrun |
| `REQ-CHAT-003` | narrow tool allowlist configured | shell denied; proposals cannot execute code | TEST-CHAT-003 | unrun |
| `REQ-CHAT-004` | file bytes match download | ../secret rejected | TEST-CHAT-004 | unrun |
Risk stages: all; live authenticated SDK spike and permission controls required.
Oracle: github/copilot-sdk docs/auth and installed TypeScript SDK contracts.
## Design
Fresh SDK session per turn with bounded history from the project's single persistent chat; empty working directory, discovery/skills/file hooks disabled, deny-by-default permissions and explicit safe tool inventory.
PostgreSQL stores turns/versions; serialize chat work per project. Server derives the chat ID from the project, not a chat selector. SDK cleanup mandatory. Exact-payload consent required for files/results; small text-tool arguments remain distinct from streaming 100 MiB files.
## Assumptions / risks
Uses existing CLI credentials server-side, no token UI; Copilot sends selected chat text to GitHub and may incur charges. Real SDK 1.0.29 synthetic reply + save_file spike passed with an absolute CLI path (2026-11-08); providers deferred.
