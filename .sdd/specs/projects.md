---
feature: projects
tier: T2
approval: human
---
# Projects and local boundary
Goal: persist a local owner's research projects in PostgreSQL; no Internet-facing deployment or authentication.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-PROJECT-001 | When a project with a trimmed 1..120-character name and at most 2000-character description is created or edited, the system shall persist it under the local owner and return it after reload. | TEST-PROJECT-001 |
| REQ-PROJECT-002 | When a project is archived, the system shall retain its data and reject subsequent content mutations with 409. | TEST-PROJECT-002 |
| REQ-PROJECT-003 | If a project ID is malformed, absent, or not owned by the actor, then the system shall return 400, 404, or 404 respectively without exposing other data. | TEST-PROJECT-003 |
| REQ-PROJECT-004 | If an API request has a Host outside loopback and the exact explicitly configured trusted-LAN public-origin Host, a cross-origin Origin, or a non-upload body above 12 MiB, then the system shall reject it with 403, 403, or 413 respectively; raw uploads follow the data contract. | TEST-PROJECT-004 |
| REQ-PROJECT-005 | If a project update has a stale revision or archive is requested while a chat or execution is active, then the system shall return 409 without changing the project. | TEST-PROJECT-005 |
| REQ-PROJECT-006 | When the owner pins/unpins or opens a visible owned project, the system shall persist its pin state or server-recorded last-open time across clients/reloads without changing research content, chat identity, content revision or active/archived status. Navigation metadata changes shall also be allowed for archived projects, but malformed input shall return 400 and absent/foreign/hidden targets shall return 404 without changes. Project lists shall order by last-open time descending, unopened projects last, then creation time descending and ID for ties. | TEST-PROJECT-006; TEST-PROJECT-007 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-PROJECT-001` | Unicode name survives reload | blank name rejected 400 | TEST-PROJECT-001 | unrun |
| `REQ-PROJECT-002` | archived row remains readable | chat write after archive returns 409 | TEST-PROJECT-002 | unrun |
| `REQ-PROJECT-003` | only owned UUID resolves | another owner receives 404 | TEST-PROJECT-003 | unrun |
| `REQ-PROJECT-004` | localhost accepted; exact configured public Host accepted with absent or matching public Origin | unconfigured LAN Host, wrong public port, forwarded-host spoofing and cross-origin Origin rejected | TEST-PROJECT-004 | unrun |
| `REQ-PROJECT-005` | archive works after work settles | active run blocks archive; stale edit preserves name | TEST-PROJECT-005 | unrun |
| `REQ-PROJECT-006` | pin/unpin/visit survive a new repository instance and recent ordering; archived metadata changes preserve content revision | client-supplied visit timestamp, foreign/hidden mutation or navigation update changes research revision | TEST-PROJECT-006; TEST-PROJECT-007 | not re-run for this documentation revision |
Risk stages: contract, inputs, verdict, history, integration; execution covered by runner.
Oracle: confirmed local-only scope and PostgreSQL transaction semantics.
## Design
Next.js Node API stays bound to loopback, including trusted-LAN mode. The fixed local actor remains shared, without authentication. Host must be localhost/127.0.0.1/[::1] with an optional valid port, or the exact AIRA_PUBLIC_ORIGIN Host; missing Origin allowed, supplied Origin must match that Host's authorized origin. The public origin is validated by trusted-lan; do not infer it from forwarded headers. No permissive CORS. Retain nosniff, same-origin resource policy and deny framing; this is not OS-user authentication.
States: active -> archived; archived research is read-only; no physical project deletion/unarchive (isolated validation backup restore belongs to diagnostics). The project-visibility contract adds reversible hide/restore without changing this content lifecycle. Parameterized SQL and row locks order archive and visibility changes against writes.
Navigation metadata uses migration-backed `pinned`, `created_at` and nullable `last_opened_at` columns. `POST /api/projects/:id/pin` accepts only `{pinned: boolean}`; `POST /api/projects/:id/visit` accepts only an empty object and records server time when a workspace is opened. Both retain owner/visibility checks and the writer fence, but do not increment the research revision. Ordinary GET requests do not record visits. This exception for organization metadata does not permit archived content edits or unarchive.
These transactions may wait behind Notebook writes under the shared writer fence; they are not parallel writer exceptions and cannot invalidate a content-revision confirmation. Visibility/archive races use the state seen under that fence: hidden targets refuse404, visible archived targets allow navigation metadata. Browser dirty/busy departure and archive prompts belong to REQ-LAYOUT-002, not an impossible server-side inspection of unsaved drafts.
The sidebar exposes Edit details, Pin/Unpin and confirmed Archive, not Delete project. The legacy hide API and restoration of already-hidden projects remain governed by project-visibility. Creation/editing accepts an empty description; the workspace modal requirements and internal scrolling are defined in REQ-LAYOUT-006.
## Assumptions / risks
Responsive Japanese/English UI; 12 MiB non-upload limit; archive-only content lifecycle plus reversible visibility. Revision and archive-race tests retire assumptions. Localhost does not protect against other OS users. Opt-in trusted-LAN clients share the local owner's read/write/confirmation authority; a home firewall is not authentication or encryption.
Pre-existing projects receive creation metadata during migration; their original historical creation order cannot be reconstructed. Pin state defaults to false and last-open time to null. Existing data must migrate without initialization.
## Navigation verification
Existing exact test titles in `test/projects.test.ts`:
- `TEST-PROJECT-006 project pins and recent visits persist without changing research revisions`
- `TEST-PROJECT-007 project navigation rejects invalid inputs and foreign or hidden projects`

The sidebar integration is exercised by `TEST-LAYOUT-010 project search, persistent pins and recent ordering share the revised menu` in `test/workspace-layout.test.ts`. IDs map existing assertions; historical approvals/evidence are not renewed by this documentation update.
