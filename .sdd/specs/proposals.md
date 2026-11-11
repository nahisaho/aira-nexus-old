---
feature: proposals
tier: T2
approval: human
---
# Confirmed AI operations and disclosure
Goal: AI proposes Notebook changes/execution, while the user authorizes exact effects and outbound results.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-PROP-001 | When AI proposes Notebook creation or a cell change, the system shall persist a pending typed proposal without modifying the Notebook; only user acceptance against the displayed current revision shall apply it, and stale acceptance shall return 409. | TEST-PROP-001 |
| REQ-PROP-002 | When execution is prepared, the system shall issue a five-minute one-use confirmation bound to actor/project/its single chat/cell, immutable source/revision snapshot, typed sharing, input-version hashes and runtime epoch/image; changed or expired new admissions shall return 409 or 410 without execution. | TEST-PROP-002 |
| REQ-PROP-003 | When the user selects results for AI feedback, the system shall preview the exact <=32 KiB UTF-8 outbound text and source-run/file identities and send it only after confirmation of that unchanged payload. | TEST-PROP-003 |
| REQ-PROP-004 | When a confirmed request is admitted, the system shall atomically consume its purpose-bound grant, insert the unique owned request/fingerprint job and persist its receipt; same-intent retries shall return that receipt even after source edits, project archive or expiry, while changed fingerprints, wrong-purpose use or grant reuse for a new request shall return 409. | TEST-PROP-004 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-PROP-001` | accepted diff changes exactly one revision | pending/rejected proposal leaves bytes untouched | TEST-PROP-001 | unrun |
| `REQ-PROP-002` | one confirmed request yields one run receipt | changed input/epoch, expiry or replay starts no new run | TEST-PROP-002 | unrun |
| `REQ-PROP-003` | approved preview matches submitted bytes | edited/unconfirmed result sends no data | TEST-PROP-003 | unrun |
| `REQ-PROP-004` | consumed-grant retry after edit/archive/expiry returns same receipt with no effects | rollback consumes nothing; changed intent/new ID/wrong-purpose grant rejected | TEST-PROP-004 | unrun |
Risk stages: all; confirmation state transitions and payload binding require enumeration.
Oracle: user-confirmed AI operations and explicit result disclosure; consent is not a safety certificate.
## Design
Proposal states: pending -> accepted/rejected; stale -> requires new proposal. Database binds confirmations to immutable operation fingerprints.
Safe SDK tools only propose operations; server acceptance/dispatch is separate. Server captures owned snapshots/outbound bytes; client selectors and expected revisions/hashes are preconditions, not authoritative source/actor/chat records. After scope/shape validation, match owned prior receipt against original request intent plus its stored sealed snapshot, never recaptured current state, before expiry/revision checks; new admissions atomically lock active project, validate/consume grant and insert job/receipt. Missing/malformed confirmation400, unknown/changed/consumed grants or changed requests409, expired new grants410, foreign IDs404. Purpose-separated execution/disclosure grants; retries never launch/send again.
## Assumptions / risks
Five-minute expiry and 32 KiB feedback are conservative defaults; clock-controlled expiry and cross-scope tests retire them. No standing execution or disclosure permission.
