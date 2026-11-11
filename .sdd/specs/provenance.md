---
feature: provenance
tier: T2
approval: human
---
# Inspectable research records
Goal: trace artifacts to the code, inputs and environment observed for their production, without claiming scientific validity.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-PROV-001 | Before dispatching a cell, the system shall durably snapshot run ID, source/revision, selected input-version hashes, typed sharing, kernel epoch, image digest and observed Python/R/package versions; terminal status and timestamps shall remain inspectable after restart. | TEST-PROV-001 |
| REQ-PROV-002 | When an upload or generated file is published, the system shall expose only verified immutable bytes with committed owned metadata containing SHA-256/size/timestamp/upload-or-turn-or-run origin and project-chat/Notebook links; partial or orphan blobs shall remain invisible and never be adopted without verified metadata publication. | TEST-PROV-002 |
| REQ-PROV-003 | When source or runtime state changes, the system shall distinguish retained historical outputs from current cell results and display stale/lost-state indicators instead of inferring execution order or restored variables from the current document. | TEST-PROV-003 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-PROV-001` | inspect exact inputs/image used for a run | changed file's latest version cannot replace recorded input | TEST-PROV-001 | unrun |
| `REQ-PROV-002` | old version hash survives new publication; failed origin remains unsuccessful | crash/fence rejection between blob write and metadata commit leaves no visible/adopted version | TEST-PROV-002 | unrun |
| `REQ-PROV-003` | edits mark old output stale; restart loses variables only | displayed cell position not invented as run order | TEST-PROV-003 | unrun |
Risk stages: inputs, history, verdict, execution and integration; contract must separate observation from proof.
Oracle: retained snapshots and actual byte hashes; Open Science ArtifactVersion/run metadata supply prior art.
## Design
Immutable runs and file versions are authoritative; latest outputs/listings are projections. Write and verify owned immutable blob bytes before transactional metadata publication; filesystem writes are not a PostgreSQL transaction. Stage generated versions against the durable job, then atomically commit terminal run/turn facts and visible artifact metadata under the writer fence; failed/interrupted origins remain visibly unsuccessful. Recovery never exposes partial blobs or claims successful publication from an uncertain commit.
Stale completion retains its run and artifacts, never overwrites newer source, and resets the affected runtime. Missing capture is labeled unavailable, not reconstructed as verified evidence.
## Assumptions / risks
No replay graph, regulatory signatures or scientific-validity assertions. Snapshot/hash and source-edit tests retire traceability assumptions; user code is untrusted.
