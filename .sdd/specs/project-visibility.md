---
feature: project-visibility
tier: T2
approval: human
---
# Recoverable project visibility
Goal: preserve the existing owner-scoped hide/restore API and restoration of hidden projects without deleting research; the current project menu has no hide/delete action.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-VIS-001 | When the owner explicitly invokes the retained hide API with the current project revision and no queued/running chat or execution, the system shall atomically mark the owned project hidden and increment its revision, retain all research and underlying active/archived status, omit it from the ordinary list and return 404 from ordinary project routes including reads, edits, archive and content mutations. The workspace project menu shall not expose logical deletion. | TEST-VIS-001; TEST-LAYOUT-001 |
| REQ-VIS-002 | When the owner opens deleted projects in settings, the system shall list only the owner's hidden projects and allow explicit revision-bound restoration to the ordinary list with unchanged research and underlying active/archived status. | TEST-VIS-002 |
| REQ-VIS-003 | If hide/restore has malformed input, then the system shall return 400; if its ID is absent/foreign, 404; if its revision is stale, hide targets a hidden project, restore targets a visible project or hide targets queued/running work, 409; all refusals shall leave state unchanged and hide shall serialize against new work admission. | TEST-VIS-003 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-VIS-001` | hidden project and content inaccessible through ordinary reads/writes; rows/blobs retained | direct URL writes, chat admission or history leaks after hiding | TEST-VIS-001 | unrun |
| `REQ-VIS-002` | restore/reload retains exact chat, notebook and file identities; archived remains read-only | restoration duplicates chat, unarchives or loses research | TEST-VIS-002 | unrun |
| `REQ-VIS-003` | valid current transitions succeed; busy/stale/foreign/racing requests have no partial effect | request using old revision or admitted job survives hide fence | TEST-VIS-003 | unrun |
## Design
Add a migration-backed nullable visibility marker to projects, keeping active/archived content lifecycle unchanged; use existing owned writer transactions, project row locking and revision validation. Ordinary project scope and admission reject hidden projects; only dedicated owner-scoped deleted-list/restore operations bypass the visibility predicate.
No DELETE/cascade/blob removal, runtime termination, automatic restoration or unarchive. Restore and hide share the writer fence; failure responses use existing ServiceError shape. Explicit API requests bind the target project/revision. The project ellipsis menu offers details editing, pin/unpin and confirmed archive instead of hide/delete; existing hidden projects remain restorable from global settings.
## Assumptions / risks
Restore is available from the global settings dialog. Logical deletion is a visibility change, not authentication or physical erasure; LAN clients still share the owner. Real PostgreSQL scope/concurrency and browser restore tests must verify this. Existing live data must migrate without initialization.
The browser restore regression seeds a hidden project through the retained API, not a removed delete menu item. This revision changes UI availability, not the retained backend hide/restore semantics or historical approval records.
