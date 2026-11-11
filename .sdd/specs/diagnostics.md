---
feature: diagnostics
tier: T2
approval: human
---
# Local readiness, diagnostics and backup
Goal: identify missing prerequisites and restore research records without exposing SDK credentials.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-DIAG-001 | When readiness is checked or an operation fails, the system shall report DB socket/application-role least-privilege/writer-lease held-lost-or-unknown/CLI/Copilot-auth/Docker/runtime-image status with actionable codes and structured event IDs/timestamps/status, without credentials, full prompts or research contents. | TEST-DIAG-001 |
| REQ-DIAG-002 | When documented database-plus-blob backup/restore runs against a separate empty validation database/storage, the system shall preserve projects/exact-one chats/notebooks/run-proposal history/file bytes-hashes while keeping historical runtime/application identities inert, without exporting credentials, granting source-container authority or modifying the source database/storage. | TEST-DIAG-002 |
| REQ-DIAG-003 | When the user opens AIRA Nexus settings at the bottom of the left project pane, the system shall expose a Diagnostics section and an explicit Run diagnostics action even without a selected project. Opening/reopening settings shall not run readiness probes. Running shall show the readiness JSON or an explicit diagnostic error, clear old results before a rerun, prevent duplicate runs/closing while busy, and preserve unrelated settings errors. There shall be no center-pane Files/Diagnostics toolbar buttons or Diagnostics tab. | TEST-DIAG-003 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-DIAG-001` | missing image/auth/socket and least-privilege role/held-lost-unknown lease reported | elevated role/lost lease never ready; sentinel secret/prompt absent from payload/log | TEST-DIAG-001 | unrun |
| `REQ-DIAG-002` | independent restore matches links/hashes/exact-one chats and inert historical identities | original DB/storage/containers untouched; credentials absent; restored history grants no cleanup authority | TEST-DIAG-002 | unrun |
| `REQ-DIAG-003` | explicit settings action makes one readiness request; busy controls, JSON result, failed rerun and home/project access behave correctly | settings opening triggers probes, old success remains after failure or center diagnostic button/tab persists | TEST-DIAG-003 | not re-run for this documentation revision |
Risk stages: inputs, execution, verdict, history and integration; restoration is isolated and explicit.
Oracle: actual prerequisite probes, backup contents and separate-database restore comparison.
## Design
Server-side readiness facade and redacted structured events; metadata/history live in PostgreSQL, immutable version blobs in private owned storage. Database socket/role/writer-lease readiness is separate from kernel/Copilot readiness. No browser token editor or full admin log-management UI; credentials are not research records.
The settings Diagnostics section appears after Appearance and before the integration catalog. 診断を実行 / Run diagnostics explicitly requests `GET /api/readiness`; 診断結果 / Diagnostic results labels the JSON result. Diagnostic errors have separate state from settings load/save errors. The shared busy state disables the run/close actions while the request is pending. The controls only inspect/report prerequisites: they do not repair the environment, execute research code or start authentication.
Document a quiescent single-writer backup of pg_dump plus referenced immutable blobs/hash manifest; restore only into an explicitly new empty validation database and separate owned storage, without copying SDK/DB credentials. Preserve historical runtime/application identities as inert provenance, never live lease or Docker-cleanup authority; restored control identity is independent and unresolved jobs become interrupted without touching source containers. Validate hashes/scope/exact-one chats before use; no overwrite/automatic resume. Synthetic tests only; no custom .science format.
## Assumptions / risks
Uploaded research content may itself contain sensitive data; backups need user-controlled storage/access. Backup is not automatic publication. Real restore and redaction tests retire assumptions.
REQ-DIAG-003 is covered by the existing exact test title `Diagnostics runs manually in settings without center toolbar actions` in `test/workspace-layout.test.ts`, with English labels also checked by TEST-LAYOUT-003. The documentation revision does not renew backend qualification or approval receipts.
