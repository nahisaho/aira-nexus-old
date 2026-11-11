---
feature: sources
tier: T2
approval: human
---
# Immutable computational citations
Goal: navigate computational evidence locally without treating a citation as proof or expanding it into LLM context.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-CITE-001 | When the user copies or opens [run:<UUID>] or [file:<versionUUID>], the system shall resolve only records in the owned project and show the exact run snapshot or immutable file version with origin/hash metadata; malformed IDs return 400 and foreign/unknown IDs return 404 without disclosure. | TEST-CITE-001 |
| REQ-CITE-002 | When a cited cell is edited or its kernel restarts, the system shall retain the cited run's original source/revision, inputs, outputs, status and observed environment, distinguishing it from the current cell rather than resolving to its latest run. | TEST-CITE-002 |
| REQ-CITE-003 | When citation tokens occur in displayed text or chat history, the system shall not automatically load their bytes into the SDK payload or call an evidence tool; sending an excerpt/result shall use the existing exact-payload confirmation and 32 KiB UTF-8 limit. | TEST-CITE-003 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-CITE-001` | copied run/version ID opens matching immutable metadata | foreign ID is 404; malformed ID is 400; unresolved token shows a warning | TEST-CITE-001 | unrun |
| `REQ-CITE-002` | old citation still opens old source/output after edit/restart | [cell:id] alone never silently selects the latest run | TEST-CITE-002 | unrun |
| `REQ-CITE-003` | citation display causes no SDK evidence expansion | denied or stale exact-payload consent sends no file/result bytes | TEST-CITE-003 | unrun |
Risk stages: inputs, history, verdict and integration; scoped resolver and outgoing SDK payload tests required.
Oracle: immutable provenance records; References/aira/backend/src/services/provenance-validator.ts:54-56 illustrates cell citations, not immutable run identity.
## Design
The Next.js server resolves actor/project-scoped IDs using provenance/data repositories; bounded previews reuse existing limits. UI cards expose a copy action and show failed/interrupted/stale evidence honestly.
Run IDs replace ambiguous cell-only citations. Imported cell citations and missing execution evidence remain unresolved; this feature adds no ambient SDK tools, automatic file reads or cross-project search.
## Assumptions / risks
Existing grants, immutable records and preview limits are prerequisites. Local source links are not literature citations, semantic validation or evidence of scientific validity. Production source-edit, foreign-ID and consent integration tests remain unrun.
Isolated spike (2026-11-08): browser citations caused no lookup until click; local scoped resolver retained original run/version/hash after edits, restart and returned-copy mutation, and refused foreign/unknown/malformed IDs. Exact 32 KiB UTF-8 preview/identity binding, staleness/expiry/denial/replay/receipt controls passed in a synchronous fixture, with zero ambient evidence expansion.
Evidence: session files/scientific-consent-spike/attempt-2821f11c-0541-484c-ab7e-65b7eabef005/validation.json. No live SDK sends, PostgreSQL ownership/atomicity/concurrency/durability or production source API qualification; official TEST rows remain unrun and policy approval remains required.
