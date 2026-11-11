---
feature: research-checks
tier: T2
approval: human
---
# Local advisory research checks
Goal: disclose missing computational references and execution evidence, not certify findings or repair reports automatically.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-CHECK-001 | When a user requests checks on a captured report/chat/Markdown-cell snapshot of at most 64 KiB UTF-8, the system shall report detected numeric-claim locations and same-paragraph immutable run references as passed, warning or not_checked; absent/broken references warn, zero detected claims are not_checked and excess input returns 413. | TEST-CHECK-001 |
| REQ-CHECK-002 | When execution evidence is checked, the system shall distinguish completed runs without error outputs from failed/noncompleted runs and unavailable observed Python/R/package/image metadata; imported outputs are not execution proof and stderr warnings alone are not execution failures. | TEST-CHECK-002 |
| REQ-CHECK-003 | When seed declarations are inspected, the system shall report recognized Python/R declarations only in cited immutable source as heuristic information; absence or unsupported syntax is not_checked, and declarations never assert that a seed was applied or that results reproduce. | TEST-CHECK-003 |
| REQ-CHECK-004 | When an owned request/fingerprint check finishes, the system shall retain one immutable local report/receipt with target identity/hash/checker version/cited runs/verdicts/examined-omitted scope; same-intent retries shall return its original receipt without duplicate reports, changed intent or stale-writer publication shall return409, and no source edits/code execution/AI sends/scientific-validity label shall occur. | TEST-CHECK-004 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-CHECK-001` | AUROC = 0.83 with valid same-paragraph run link passes linkage only | uncited p < 0.001 warns; DOI/year/code examples are excluded; zero claims not_checked | TEST-CHECK-001 | unrun |
| `REQ-CHECK-002` | completed recorded environment differs from unavailable evidence | imported output or missing environment never passes; warning stderr alone does not fail | TEST-CHECK-002 | unrun |
| `REQ-CHECK-003` | random.seed/np.random.seed/np.random.default_rng/set.seed show heuristic declarations | absent declaration or unrecorded earlier cell is not_checked, never assumed seeded | TEST-CHECK-003 | unrun |
| `REQ-CHECK-004` | source edit retains old hash; lost-response retry returns same receipt/report | archive/new changed intent/stale-epoch publication409; no source/code/LLM effects | TEST-CHECK-004 | unrun |
Risk stages: inputs, verdict, history and integration; false-positive and missing-evidence fixtures required.
Oracle: explicit checker scope and immutable snapshots, not a model verdict; References/aira/backend/src/services/provenance-validator.ts:24-56,170-205 and provenance-validator.test.ts:147-165 supply limited prior art.
## Design
Server captures owned file-version/chat-turn/Markdown-cell text from canonical records, validating selectors and expected revision/hash; never label replacement client text as that target. Reject source >64 KiB rather than checking a prefix; immutable capture prevents later rebinding. Reuse durable purpose=check request/job/receipt admission without an execution/disclosure grant; owned same-intent retries resolve original sealed snapshot/checker version before current-source/archive checks. Publication validates active ownership/current writer epoch and unique report/job linkage; reports are local records, not uploads/AI turns/runs or validity grades.
Recognize AUROC/AUPRC/F1/accuracy/precision/recall/MAE/RMSE/MSE/R2 decimal assignments, p-value comparisons and n=integer outside code/DOI/reference labels, including sentence-final punctuation but excluding decimal/exponent/percent continuations. Match only same-paragraph owned immutable run references; record unsupported tables/unmapped locations and seed aliases/multiline syntax as omissions. Numeric proximity does not establish agreement, units, causality or seed execution; display limitations with every report.
## Assumptions / risks
Grammar and64 KiB scope await human approval; production tests must cover target forgery/foreign IDs, before/after-capture edits, archive races and checker-version persistence. No raw imported/native-run claims become evidence merely by client metadata; no overall pass conceals examined/omitted scope.
Isolated spike (2026-11-08): 14 numeric grammar rows, completed/error/imported/missing-environment evidence, literal Python/R seed heuristics, immutable local hashes and archive/no-effect controls passed. Reviewer-found sentence-final claim omission had native assertion Red and was fixed without accepting decimal continuation/percent forms; no scientific-validity or applied-seed assertion.
Evidence: session files/scientific-consent-spike/attempt-2821f11c-0541-484c-ab7e-65b7eabef005/validation.json. Table cells lacking mapped locations and unmodeled literal/alias/multiline syntax are explicitly omitted. Captured-target authority, PostgreSQL persistence/ownership/concurrency and full native TEST/approval remain unqualified; local synchronous fixtures are not production.
