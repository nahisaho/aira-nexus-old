# Project visibility specification review
Reviewer model: Claude Sonnet 5.5. Initial: c0047d5a-f138-412f-a4b1-027650eb3bda. Fix-only: fb88467d-6863-403a-bc19-e3fd0d16b165.

VIS-SPEC-01 | medium | .sdd/specs/project-visibility.md:12 | closed: explicit input/transition/status mapping; invalid transitions are not idempotent success.
VIS-SPEC-02 | medium | .sdd/specs/project-visibility.md:10 | closed: ordinary hidden-project reads/rename/archive/mutations return 404.

Scope: specification wording only. No implementation, mutation, test or human-approval evidence. Fix-only reviewer reports CLEAN.

Pre-implementation evidence: initial VIS001/002/003 native runs failed by assertion against explicit 503 method stubs. The first strengthened VIS001 run instead failed with CANCEL_NOT_REQUESTED in fixture setup; although the native tool printed RED ok, this is not counted as assertion evidence. Tests now request cancellation before finishing cancelled jobs.

VIS-IMPL-01 | high | src/server/research-checks.ts:539 | closed: hidden projects leaked completed report replays, occupied global check capacity and stranded publication jobs. Scope receipt replay before returning, exclude hidden jobs from admission capacity, internally finish hidden checks failed without report before returning404; preserve archived receipts and chat/execution-only hide busy rule. Both Claude Sonnet5.5 reviewers independently CLEAN against frozen candidate2.
VIS-REVIEW-SCOPE | medium | test/project-visibility.test.ts:1 | closed: candidate1 state review omitted actual specs/tests; contract review omitted actual tests/helper. Both completed omitted scope against frozen candidate2 in explicit follow-ups; state reader confirmed all387 test lines,144 helper lines and complete projects spec.

Candidate2 evidence:7 current visibility/research-check tests PASS, native VIS001/002/003 Greens and TS/ESLint diagnostics PASS. VIS001 reproduces actual hidden report replay assertion; VIS002 reproduces actual four-paused-check capacity assertion. Its initial NOTEBOOK_ASSOCIATION_NOT_FOUND was invalid cross-project fixture metadata, not counted as Red; independent fresh control metadata resolves it without weakening validation. VIS003 detects isolated busy-guard fault; production source restored byte-identically to candidate1 before native Greens. Full mutation coverage, current prerequisite/task receipts, catalog/layout implementation and final qualification remain pending. Logs/manifests retained in session files; approved specifications unchanged.

Implementation reviewers: state b0bcd051-6e89-473d-b098-7c96c4ed375d; contract581c456b-7a19-4dee-83f1-20c96aa1d835. Follow-up fix reviews and final omitted-scope closure CLEAN; no test execution claimed by reviewers. Retained limitations: race test need not cover both winners each run; hide+restore before publication/process-death resume not directly covered; sequential fixture closers may abort following cleanup on a throwing closer. No open high-confidence bug reported.

Restored mutation results2 PASS:11 actual isolated faults in ordinary scope, visible-list marker, deleted-list actor, retained chat, revision, operation receipt scope, check replay scope, hidden capacity, terminal state, report publication and column UPDATE grant each produce assertion failures; all12 frozen files restored byte-identically and every affected valid control passes. Additional busy-guard fault has native Red/Green proof. Native13 affected original test evidences refactor-revalidated PASS. Current task receipt/prerequisite verification running; no full-project qualification or rollout claimed.

## Expanded adoption: candidate6 specification readiness

Spec: `.sdd/specs/project-visibility.md`; SHA256 `8c2a0b3e7fbd3fd3c1c402fe2a77c867bfeeb2e3191760d27e1c540d4bafb24c`.
Independent Claude Sonnet5.5 agent: `653f314d-33dc-4b24-a9cf-600218161f76`; final bounded contract verdict: ready for exact-spec approval, not source qualification. Immutable manifest: session `integrated-source-manifest6.json`.

Contract findings: closed in reviewed fix delta. Implementation/evidence: OPEN — No project-menu hide/delete; retained API/restore and reversible archive remain distinct.
Human exact-hash approval and expanded frozen qualification remain pending. Historical review sections are preserved below/above and do not qualify this source.
