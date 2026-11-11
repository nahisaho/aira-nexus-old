---
feature: operations
tier: T2
approval: human
---
# Durable work lifecycle and cleanup
Goal: cancel, retry and recover chat/cell work without duplicate effects or false completion.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-OPS-001 | When chat, execution or an advisory check is admitted, the system shall persist request ID/fingerprint and queued/running lifecycle before effects, fence mutations and terminal commits against the current writer epoch, and expose completed/failed/timeout/cancelled/interrupted outcomes with observed or explicitly unknown started/cleanup status. | TEST-OPS-001 |
| REQ-OPS-002 | When an owned request ID is retried, the system shall return its original job/receipt without repeating effects for the same fingerprint, reject a different fingerprint with 409, and confirm cancellation only after the owned operation has stopped. | TEST-OPS-002 |
| REQ-OPS-003 | When the app starts or shuts down, the system shall enforce one writer lease/epoch, reconcile unresolved jobs as interrupted without replay, and stop only containers proven to belong to its persisted application/job control identities; lease loss shall stop admission/dispatch, mark cleanup uncertain and block reuse until verified. | TEST-OPS-003 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-OPS-001` | durable lifecycle/unknown-start status survives restart | stale-epoch terminal commit rejected; connection loss cannot fabricate completion | TEST-OPS-001 | unrun |
| `REQ-OPS-002` | retry returns identical run ID | changed payload conflicts; cancel/complete race has one terminal winner | TEST-OPS-002 | unrun |
| `REQ-OPS-003` | owned orphan stopped; foreign/restored-history containers untouched | second writer/lease-loss admission/dispatch/reuse reject; reacquisition never replays intents | TEST-OPS-003 | unrun |
Risk stages: all; enumerate terminal transitions, retry identities, cancellation races and restart ownership.
Oracle: durable job facts and verified owned-process termination, not absence of a response.
## Design
One database-wide writer holds a dedicated PostgreSQL advisory-lock connection and durable monotonically increasing epoch; every mutation/terminal commit is fenced against that epoch. Lease loss stops admission/dispatch and marks runtime cleanup uncertain until verified recovery; reacquisition never replays unresolved dispatch intents. Unique (actor,requestId), immutable purpose/fingerprint and grant/job/receipt transaction provide idempotent admission, not exactly-once delivery to GitHub. Execution-started may be unknown; terminal state, stale projection and cancellation intent are independent observed facts.
Persist exact application/container identities with matching labels; fail closed on ownership/cleanup uncertainty. Idle runtime expiry is 10 minutes; active work is bounded separately.
Production DB candidate: local Linux/WSL PostgreSQL17 with network-none/no TCP/ports, read-only root, cap-drop/no-new-privileges, matching nonroot UID/GID, .5 CPU/384 MiB/PIDs128 and persistent private bind data. Validate ownership/no symlinks/0700 parents, socket-path length and /var/run/postgresql bind before startup; wait for final PID1, then tighten socket leaf0700 on every start. Require local SCRAM authentication and independent persistent0600 bootstrap/migration/application credentials, never argv/log/browser; application role has only required schema DML, no superuser/role/database creation. Bootstrap/migrations run explicitly before admission; existing state never silently resets or rotates secrets, replaces containers or restores data.
## Assumptions / risks
No automatic replay after restart, no process-name cleanup, no inferred not-started status. Crash/foreign-process/race tests retire lifecycle assumptions.
Private DB transport spike (2026-11-08): PostgreSQL 17.11 in network-none/read-only/nonroot Docker served Node pg via an owned Unix-socket bind, with no published ports/TCP listener and actual SCRAM wrong-password refusal. Four transport groups plus unchanged six DB regression cases passed, including concurrency/ownership/restore and observed active SQL interrupted before same-container restart; committed data survived and uncommitted work rolled back.
Official bootstrap requires /var/run/postgresql and temporarily changes its leaf mode; an always-0700 outer parent protects it, then the owner re-tightens the leaf to700 after final PID1 startup. Short socket paths/shared POSIX bind filesystem/matching UID/GID are prerequisites. Credentials use a private0600 env file, never command argv; privileged Docker/root/same-UID environment access remains.
Evidence: session files/database-transport-spike/attempt-97612fa1-7159-478b-b0d2-44c3e98375c8/validation.json and mutation-validation.json; two isolated/restored transport regressions caught. Synthetic orderly-restart/backup fixture, not power-loss, container replacement/credential rotation, remote/rootless Docker, one-writer/receipt/SDK integration, production launcher, native TDD/full gate or human approval.
