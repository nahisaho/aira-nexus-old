# Workspace layout specification review
Reviewer model: Claude Sonnet 5.5. Initial: c0047d5a-f138-412f-a4b1-027650eb3bda. Fix-only: fb88467d-6863-403a-bc19-e3fd0d16b165.

LAYOUT-SPEC-01 | medium | .sdd/specs/workspace-layout.md:24 | closed: page-lifetime tab scope; dirty notebook navigation blocked until save/explicit discard; unload warns.
LAYOUT-SPEC-02 | medium | .sdd/specs/workspace-layout.md:12 | closed: localized server-code mapping; upstream metadata remains literal.
LAYOUT-SPEC-03 | low | .sdd/specs/workspace-layout.md:24 | accepted: unsaved-navigation guard is a documented assumption covered by TEST-LAYOUT-004, not a separate numbered requirement.

Scope: specification wording plus goal/design changes in projects/workspace/research-extensions. No implementation/test/human-approval evidence. Fix-only reviewer reports CLEAN; implementation will need actual browser and data/concurrency verification.

## Implementation candidate3

Frozen: `layout-review-manifest3.json` in session files (21 exact files).
Before-images are retained native preimplementation context, not an empty Git diff.
Fix-only delta: `layout-review-fix-manifest3.json` (Workspace, NotebookEditor, layout tests).

Reviewers: Claude Sonnet 5.5.
State: `d2ac7cba-f5ab-4f4d-b127-0825e8c1ab0a`.
Contract: `2c7fccf2-89d3-42ff-ac05-0381ad88a0a1`.
Both final source reviews are CLEAN. Initially omitted actual source/spec/test/helper ranges were explicitly read in bounded follow-ups; partial replies were not treated as full approval.

W1 | high | src/components/workspace.tsx:149 | closed: staging create/hide no longer destroys dirty viewers before the action commits; actual cancelled-create assertion Red and restored native Green.
W2 | medium | src/components/notebook-editor.tsx:103 | closed: sequence and edit-generation fences reject background reads that resolve after edits; actual paused-read assertion Red and restored native Green, with the other three reads completed before release.
T1 | medium | test/workspace-layout.test.ts:1 | closed: English workspace/dialog/accessibility labels, inert203/0 catalog display, preserved source/preview, invalid preference defaults plus explicit scoped warning and valid recovery are asserted.
T2 | medium | test/workspace-layout.test.ts:1 | closed: keyboard move focus, Chat boundary/drag immovability and visual left position are asserted.
LAYOUT-REVIEW-SCOPE | medium | test/helpers/workspace.ts:260 | closed: full omitted helper and editor controls read; no Green-name/hash-only substitute for semantic review.

Actual evidence:
- Preproduction full native consistency and diagnostics PASS; four genuine assertion Reds against the old UI.
- Seven initial native UI/layout Greens; subsequently strengthened tests have fresh native Reds/Greens, not inherited evidence.
- Real W1/W2 repro Reds: `layout-W1-staged-discard-assertion-red.log`, `layout-W2-background-edit-red.log`; current fix Green: `layout-fix2-TEST-LAYOUT-004-green.log`.
- New keyboard-focus and missing-preference-warning isolated assertion Reds, exact restoration, separate fault/restored builds and native Greens (`layout-review-fix-results2.json` plus the earlier keyboard-focus proof). Its copied notice says candidate2; driver argv2 actually verified immutable manifest3, whose source differs from2 only in the corrected app-alert test scope.
- Seven additional isolated faults: premature hide, duplicate viewers, closable Chat, ignored palette, non-retranslated errors, writable archived upload and autosave-on-discard. Every case assertion-detected, all21 frozen files byte-restored, and separately rebuilt valid control PASS (`layout-mutation-results3.json`).
- Original UI and citation evidence actually refactor-revalidated; current TypeScript/ESLint PASS (`layout-candidate3-final-diagnostics.json`).

Retained non-successes: initial label failures, nonexistent metadata endpoint oracle (corrected to approved download plus SHA256), stale helper-dependency Green refusal, unchanged-oracle retest refusal, and framework route-announcer alert scope failure. None counts as a successful test.

Limitations: no dedicated browser Back/unload test; normal full-document project navigation deliberately uses the unload guard. Catalog selections remain settings-only; no Agent/Skill/MCP execution, credentials or upstream browser connection. Existing broad filesystem-tracing build warnings remain. Current20-task receipt revalidation is running; full62 gate, two frozen qualification runs and live owned rollout are not yet claimed.

## Candidate4 composed E2E closure

Actual20-task verification passed/adopted14 upstream tasks, then failed workspace's separately declared built E2E check (timeout); remaining tasks and final plan consistency were not completed.

E1 | medium | test/e2e/workspace.spec.ts:12 | closed: projectFlow's mobile assertions end at390px; subsequent independently desktop-tested flows now explicitly restore1100x900 and assert explorer visible. Actual pre-fix visibility assertion Red retained.
E2 | medium | test/helpers/workspace.ts:365 | closed: both math waits now select visible math, not a hidden first math in mounted inactive Chat. Notebook math was actually visible in the failed composed-flow snapshot. Actual full three-flow E2E PASS after this change (layout-e2e-visible-math-green.log).

Contract reviewer `2c7fccf2-89d3-42ff-ac05-0381ad88a0a1` independently read the actual two-selector delta and full18-line E2E wrapper from immutable candidate4, final CLEAN. Mobile project assertions and subsequent XSS assertions remain. Production/specs are byte-identical to3. Candidate4 adds the E2E wrapper to the fixed manifest (22 files).

Earlier current-helper native Greens are not inherited after this oracle dependency change. Actual seven source-fault/rebuilt-restored-control native Reds/Greens are running in layout-e2e-current-oracles.mjs; current diagnostics, resumed dependency-order receipts, full62 gate and two frozen qualification runs remain pending.

Subsequent actual result: all7 dependency-current isolated source assertion Reds detected, all22 files restored byte-identically, fresh restored-build/native Green valid controls PASS (`layout-e2e-oracle-results.json`). Exact restored candidate4 TypeScript/ESLint diagnostics PASS. Resumed dependency-order native receipt verification and conditional two-run full qualification are running; no qualification/publication claim before actual outputs are inspected.

## Expanded adoption: candidate6 specification readiness

Spec: `.sdd/specs/workspace-layout.md`; SHA256 `1f37b3353490aa7a7bd1032f368aca79fba581b19ceb1750eaea3adb270f9878`.
Independent Claude Sonnet5.5 agent: `653f314d-33dc-4b24-a9cf-600218161f76`; final bounded contract verdict: ready for exact-spec approval, not source qualification. Immutable manifest: session `integrated-source-manifest6.json`.

Contract findings: closed in reviewed fix delta. Implementation/evidence: OPEN — Current TEST002/005 bodies retain fixed-ELN assertions; new mixed-viewer/dirty/busy/async coverage and implementation pending.
Human exact-hash approval and expanded frozen qualification remain pending. Historical review sections are preserved below/above and do not qualify this source.
