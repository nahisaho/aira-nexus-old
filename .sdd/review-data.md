EXP-03|high|.sdd/specs/data.md:24|Fixed in draft: bounded offset/hash/ack chunk framing, final verification and partial-transfer abort; 1 MiB SDK text arguments separate from 100 MiB file streams.

# Data implementation review

The approved specification is unchanged. Development: GPT-6.1 Sol. Independent review: Claude Sonnet 5.5, bounded state/storage and preview/HTTP axes, frozen round-2 snapshot followed by round-3 fix-only review. Both reviewed actual test bodies. No open findings.

| ID | Severity | Location | State |
| --- | --- | --- | --- |
| DATA-S1 | medium, test gap | test/data.test.ts | Closed: actual prior-epoch pending/renamed orphan recovery, obsolete grow/publication rejection and partial-stage rollback preserving an existing sentinel; distinct restored mutations fail by assertions. |
| DATA-S2 | low, integrity | src/server/files.ts | Closed: copy-time size/hash verification and rollback; actual post-selection corruption fails before the fix and passes after it. Same-UID host authentication remains outside the contract. |
| DATA-S3 | low, oracle | test/data.test.ts | Closed: quota race asserts one success and one 413 without assuming a winner. |
| DATA-UTF8 | implementation finding | src/server/file-preview.ts | Closed: malformed text is attachment-only; fatal UTF-8 decoding prevents negative omission counts. Valid split-character input reports exact omitted bytes. Genuine assertion Red/Green. |
| DATA-BOUNDARY | none found | src/server/file-routes.ts | Initial and delta reviews clean; actual 100 MiB streaming HTTP upload added, not merely direct service calls. |

Evidence: `/home/nahisaho/.copilot/session-state/1939ceaf-4688-40ce-abee-e605d5825a45/files`.

- `data-review-round2-manifest.json`, `data-review-round3-manifest.json`: exact independently reviewed snapshots.
- `data-fresh-native-results.json`: bounded per-file/input guard-removal native assertion Reds and restored Greens.
- `data-mutation-results-round2.json`: 16 isolated actual assertion-detected mutations, exact restoration, then all three native Greens.
- `data-mutation-results.json`: retained initial mutation-run refusal; a second `--retest` for an unchanged oracle was correctly refused, not counted as mutation success.
- `data-diagnostics-reviewed.json`: TypeScript and ESLint PASS after the fixes.
- `.sdd/tdd.jsonl`: genuine native Reds/Greens for all three DATA TEST IDs, including malformed UTF-8, copy-time integrity and real raw-upload budget controls.

Controls include real 100 MiB raw HTTP upload/exact download hashes, 256 MiB staged input hashes, one-byte overflows, pending-inclusive 2 GiB quota races, archive-at-publication, ownership, real 32M-pixel/8192-dimension raster boundaries, and real Chromium hostile HTML attachment download without execution/foreign requests.

Transport is an injected loopback Node/Chromium fixture, not production Next composition. SVG preview refusal is tested; SVG browser download is not separately qualified. PNG/JPEG decoding uses Sharp's bounded native decoder; no hostile-host isolation is claimed. Worker transfer framing belongs to the planned runner. Full product gate, remaining implementation, release qualification and publication approval remain separate. Dependency installation reported eight moderate audit vulnerabilities; no forced audit remediation was attempted.

## Expanded adoption: candidate6 specification readiness

Spec: `.sdd/specs/data.md`; SHA256 `b637b817cdfd279e96785fcee9214c5a35a90364920a7984fb78c4511c6c671d`.
Independent Claude Sonnet5.5 agent: `87c4d455-ca19-4f3e-8a2c-435fda1d86d4`; final bounded contract verdict: ready for exact-spec approval, not source qualification. Immutable manifest: session `integrated-source-manifest6.json`.

Contract findings: closed in reviewed fix delta. Implementation/evidence: OPEN — Image admission2 active/8 queued/10s and TEST-DATA-005 are PLANNED, not implemented. Existing SVG correctness/budget assertions need expansion. Isolated queue spike passed, not production proof.
Human exact-hash approval and expanded frozen qualification remain pending. Historical review sections are preserved below/above and do not qualify this source.

## Current backend slice, separate from frozen contract observations

The ten exact specification approvals were subsequently explicitly granted and recorded natively by `nahisaho`; `integrated-human-spec-approval.json` and `integrated-human-spec-approval-recording.log` retain that response and recording. The approved specification's preimplementation status prose, including "planned" and "unimplemented", is deliberately frozen at its approval-time observation. It is not a live implementation-status field. Current execution evidence below supersedes those progress observations, not the approved requirements, budgets or artifact hashes. No specification bytes or approval conditions were changed.

The current backend corrects sanitizer-repaired malformed SVG acceptance and shares two-active/eight-queued/ten-second FIFO rasterization admission across PNG/JPEG and SVG requests. Queued cancellation rejects immediately; active native work retains its slot until settlement. Admission refusals remain distinct from integrity and decoding errors. Original immutable downloads remain unchanged.

| ID | Severity | Scope | State |
| --- | --- | --- | --- |
| IMG-STATE | none found | Frozen image producers and DATA-004/005 assertions | Independent Claude Sonnet 5.5 source review CLEAN; all omitted test/contract scopes closed, including complete untruncated relevant requirements and design. Final bounded contract/reporting follow-up CLEAN. |
| IMG-CONTRACT-STATUS | reporting | Frozen approved data contract | Progress prose deliberately retained as an approval-time observation; current evidence and this review report are authoritative for execution status. No renewed specification approval or publication is implied. |
| IMG-CANCEL-ORACLE | test hardening | TEST-DATA-005 | Both raster/SVG pre-aborted actual image routes checked; queued abort must reject immediately with 409, not merely expire later; active cancellation must also reject with 409. Actual removed-listener native assertion Red and restored Green retained. |

Evidence in the session files: `integrated-expanded-images-final-native-red.log`, `integrated-expanded-images-native-green.log`, `integrated-image-cancellation-restored-native-green.log`, `integrated-data-restored-native-regressions.log`, `integrated-data-backend-final-suite.log` (14 pass, zero failures/skips/TODOs), and `integrated-image-backend-final-diagnostics.json` (native TypeScript/ESLint PASS). Eight isolated changed-mechanism mutations were assertion-detected and all producer bytes restored exactly: active cap, queue cap, FIFO, expiry, queued abort, active abort, original XML validation and raster signal propagation. Frozen manifests are `image-backend-review-round1-manifest.json`, `image-backend-review-round2-manifest.json` and the project-test-only delta in round3.

This is not whole-data-task or whole-product completion. Expanded SVG pixel/output/time boundary coverage, current compiled frontend TEST-LAYOUT-007, other rendering/tab changes, current native data receipt, full gates, frozen qualification and separate human publication approval remain outstanding. The existing app/proxy was only inspected read-only; its live `.next` was not rebuilt or its other-session processes stopped.

Independent agents: `2a9704b6-5672-4cdd-b4d3-3c0e6bb6acf2` (state/source, then actual DATA-004/005 and complete relevant contract), `761a3130-c05f-4a13-ab15-554924b18f1e` (image test adequacy, navigation contract/source, then reporting/order-oracle fix delta), both Claude Sonnet 5.5. Final replies closed the frozen-status reporting concern and the ordering-oracle finding. Reviewers performed static inspection, did not execute logs/tests and did not qualify the outstanding scopes. Frozen round4 contains the reviewed reporting and test delta; final review-status text is updated here from those actual replies.
