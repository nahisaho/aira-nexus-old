# Provenance implementation review

The approved specification is unchanged. Development: GPT-6.1 Sol. Independent review: Claude Sonnet 5.5, publication/state and snapshot/contract axes, frozen candidates followed only by fix or explicitly unread-scope deltas. Both axes ultimately read their actual test bodies. No open findings.

| ID | Severity | Location | State |
| --- | --- | --- | --- |
| PROV-P1 | medium | src/server/provenance.ts | Closed: all pretransaction validation/lookup failures clean recognized, deduplicated, matching-owner prepared bytes/reservations; unrecognized and foreign objects are never cleanup targets. Invalid-output and missing-turn quota leaks reproduced by actual assertion Red (1 versus 0), then fixed and independently re-reviewed. |
| PROV-COMMIT | implementation finding | src/server/files.ts | Closed: lost COMMIT acknowledgement previously deleted committed bytes. Cleanup now reacquires the writer fence and retains any visible version; unavailable fencing retains uncertain private bytes and reports cleanup failure, never guesses commit failure. |
| PROV-TRANSACTION | implementation finding | src/server/operations.ts | Closed: prepared publication requires the current lock-owning client inside an active writer transaction, not merely a connected application client or a borrowed lease outside its callback. Actual assertion Reds and restored controls. |
| PROV-JUPYTER-ID | compatibility finding | src/server/run-snapshots.ts | Closed: standard nbformat cell IDs use matching 1..64 ASCII alphanumeric/underscore/hyphen validators in application and SQL, not UUID-only IDs. All three native assertion Reds exposed valid `cell_source-1` refusal before the fix; canonical IDs and malformed controls now pass. Narrow independent compatibility delta clean. |

Evidence directory: `/home/nahisaho/.copilot/session-state/1939ceaf-4688-40ce-abee-e605d5825a45/files`.

- `provenance-review-manifest.json`, `provenance-review-manifest2.json`, `provenance-review-manifest3.json`: exact review snapshots and fix deltas. The first snapshot reviewer explicitly omitted test/helper/trigger scope; its separate bounded completion read those actual bodies before review was considered complete.
- `provenance-mutation-results-round2.json`: 15 isolated assertion-detected mutations on the canonical-ID candidate, source/mutant/oracle/log hashes, exact restoration, then all three native Greens. Earlier round and initial counterexamples are retained separately.
- `provenance-diagnostics-qualified.json`: current TypeScript/ESLint snapshot. `provenance-prerequisite-native-regression.log`: actual native regression of seven affected OPS/SESSION/DATA IDs, not hash-only evidence.
- `.sdd/tdd.jsonl`: genuine native Reds/Greens for all three PROV TEST IDs, including uncertain COMMIT retention, active transaction gating, invalid-output quota cleanup, Unicode and canonical Jupyter cell IDs.

Captured environment fixtures are explicitly synthetic, not actual Python/R runtime qualification. The planned runner must collect real observed environment before user-code dispatch. Notebook documents/projections, runtime isolation/typed sharing, live SDK, production Next composition and UI remain separate unfinished tasks. History sequence is snapshot chronology, not inferred cell execution order. Missing environment/output/origin capture stays null/unavailable. No scientific-validity claim, publication approval or deferred feature activation is implied.
