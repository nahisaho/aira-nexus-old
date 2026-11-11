SPEC-06|medium|.sdd/specs/projects.md:25|Fixed: literal loopback Host allowlist, no forwarded-host trust, supplied Origin must match.

# Projects implementation review

The historical specification review above is preserved. Human-approved `projects.md` bytes remain unchanged; actual execution evidence is separate from the locked specification.

| ID | Severity | Location | State |
| --- | --- | --- | --- |
| PROJECT-STATE | none found | src/server/projects.ts:80 | Two clean bounded reviews: owned fields, revision/readonly guards, archive/admission ordering and inert archived receipt retries. |
| PROJECT-BOUNDARY | none found | src/server/local-boundary.ts:15 | Two clean bounded reviews: literal loopback Host, exact Origin, bounded JSON bytes, explicit errors and consistent response headers. |
| PROJECT-DB-SCOPE-ORACLE | test hardening | test/projects.test.ts:237 | Closed: actual cross-owner job reassociation rejects PostgreSQL 23503 and retains its original project; native assertion Red under FK removal, then restored Green. |
| PROJECT-FINITE-BODY-ORACLE | test hardening | test/projects.test.ts:438 | Closed: finite adversarial body avoids unbounded allocation when the byte guard is removed; actual native assertion Red/Green and cancellation/count checks. |
| PROJECT-HTTP-HARNESS-CORP | harness correction | session files/projects-http-smoke.mjs | Closed: initial harness incorrectly expected a readable no-cors response. Chromium correctly blocked it through CORP; corrected expectation also requires server 403 and unchanged database. Initial failure retained. |

Development: GPT-6.1 Sol. Independent reviews: Claude Sonnet 5.5, state/schema and HTTP-boundary axes, frozen manifests, then bounded unread-test/final-oracle deltas. Both reviewers read actual test bodies, not merely assertion names. No open implementation findings; reviews were source inspection, not execution.

Evidence directory: `/home/nahisaho/.copilot/session-state/1939ceaf-4688-40ce-abee-e605d5825a45/files`.

- `projects-review-final-manifest.json`, `projects-review-ledger.json`: frozen source/oracle hashes and exact review limitations.
- `projects-mutation-results-round1.json`: 20 distinct assertion-detected mutations, exact restoration, current raw log hashes and input bindings. The runner refuses to overwrite an earlier round.
- `projects-restored-baseline-round1.json`: all 11 operations/sessions/projects tests pass on restored real PostgreSQL fixtures.
- `projects-http-smoke.json`: real Chromium/Node loopback create/edit/reload/archive, actor isolation, stale revisions, cross-origin rejection and oversized declared body refusal. `projects-http-smoke-initial-failure.json` retains the incorrect harness expectation.
- `projects-operations-verification-final.json`, `projects-sessions-verification-final.json`, `projects-task-verification-final.json`: actual prerequisite/task verification, with receipts adopted in the sole JSON plan.
- `.sdd/tdd.jsonl`: genuine native assertion Red/Green for TEST-PROJECT-001..005; independent FK and finite-stream oracles use actual removed-guard assertion Reds.

Commands: native `tdd red|green TEST-PROJECT-001..005`, `diagnostics --root . --json`, `plan verify operations|sessions|projects --json`; `npm run build`; restored `node --import tsx --test test/operations.test.ts test/sessions.test.ts test/projects.test.ts`.

The project router is injected and transport-tested, **not yet composed into the production Next application**. Production scaffold still returns unavailable until planned workspace/application integration; no project UI or live SDK is claimed. Host/Origin checks are not OS-user authentication. Client stream I/O errors produce logged, sanitized 500 responses; invalid JSON/UTF-8 are explicit 400s. HTTP/2, live Next stream cancellation and actual oversized chunked HTTP transport are not qualified; the byte guard is exercised with finite native Web Request streams.

Native context expands through shared-owner downstream artifacts and remains INCOMPLETE. No fake files or relaxed ownership were used. Full-product gate, remaining active requirements, deferred features and release approval remain separate.

## Expanded adoption: candidate6 specification readiness

Spec: `.sdd/specs/projects.md`; SHA256 `64135a18b436f55662bdea82d033f6f58977c9f3200cc8cbf5cd1fdaf26d3fa9`.
Independent Claude Sonnet5.5 agent: `653f314d-33dc-4b24-a9cf-600218161f76`; final bounded contract verdict: ready for exact-spec approval, not source qualification. Immutable manifest: session `integrated-source-manifest6.json`.

Contract findings: closed in reviewed fix delta. Implementation/evidence: OPEN — New navigation/description controls require current native evidence.
Human exact-hash approval and expanded frozen qualification remain pending. Historical review sections are preserved below/above and do not qualify this source.

## Current navigation adoption and ordering-oracle delta

The exact projects contract was subsequently human-approved and recorded natively. Preimplementation progress prose in that immutable approved artifact is historical; current execution status is reported separately here and in the native plan receipts.

The pre-existing navigation producer was adopted without behavior changes: only three implementation-trace annotations were added. TEST-PROJECT-006/007 obtained actual native assertion Reds under isolated inverted-pin and relaxed-input-schema mutations, followed by exact restoration and native Greens. These are mutation-derived adoption controls, not newly discovered producer defects or evidence that the earlier implementation was originally developed through TDD. Existing TEST-PROJECT-001..005 were reverified natively.

| ID | Severity | Scope | State |
| --- | --- | --- | --- |
| PROJECT-NAVIGATION | none found | Owned pin/visit/list implementation, routes, scope helper, migration012 and TEST-PROJECT-006/007 | Independent Claude Sonnet 5.5 bounded source/contract review found no producer defect. |
| PROJECT-ORDER-ORACLE | medium, test gap | TEST-PROJECT-006 | Closed by independent Claude Sonnet 5.5 fix-delta review: controlled creation timestamps include two unopened projects with an exact time tie; the assertion requires descending creation time and ascending ID. Reversed creation ordering and reversed ID ordering each caused actual native assertion Reds, then exact restoration and Green. Ascending ID is the preserved observed deterministic tie-breaker, not a new product decision. |

Current operations and sessions native PASS receipts were adopted. The first current projects verification refused incomplete evidence; its failure receipt remains retained. After the ordering assertion fix, actual current projects verification passed again and its receipt was adopted; the plan records projects complete. Logs: `integrated-project-recency-mutation-native-red.log`, `integrated-project-id-tiebreak-mutation-native-red.log`, `integrated-project-recency-restored-native-green.log`, and `integrated-current-projects-reviewed-verification.json`. Independent reviewer `761a3130-c05f-4a13-ab15-554924b18f1e` closed the ordering finding against frozen round4, with no new delta bug. Native verification success is not whole-product gates, qualification or publication.
