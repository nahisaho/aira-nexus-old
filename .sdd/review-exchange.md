EXP-04|medium|.sdd/specs/exchange.md:10|Fixed in draft: oversized body/display data rejected 413; no silent import truncation.

# Production Exchange review

Frozen candidate: session artifact `exchange-review-manifest2.json` (14 SHA-256-bound files). Claude Sonnet 5.5 contract and execution reviewers each returned two clean focused rounds. Approved specifications are unchanged.
Reviewer IDs: contract `0b73aae5-9b6c-45f9-819d-9c10ad246548`; execution `d83473bd-1449-482c-86d6-7acc917409ef`.

| ID | Severity | Location | State |
| --- | --- | --- | --- |
| XCH-C1 | High | src/server/notebooks.ts:403,415,541; src/server/migrations/009-exchange.sql:1 | Closed: atomic append-only original record supplies subsequent save allowance; bounded optimistic PATCH preserves large inert history. Ordinary forged metadata remains capped. |
| XCH-C2 | Medium | src/server/exchange.ts:110; test/exchange.test.ts:101 | Closed: original output-array/attachment JSON is counted before stream joining, with exact-limit valid and +1 invalid controls. Empty arrays/objects remain counted; the contrary claim was withdrawn. |
| XCH-E1 | High | test/exchange.test.ts:146 | Closed: actual captured verify-cell stdout and every positive execution count are asserted. |
| XCH-E2 | Medium | test/exchange.test.ts:155 | Closed: database import/re-export pins inert origins, external counts, code/bootstrap history and raw/Markdown attachments. Injected initialization history is explicitly synthetic, not actual kernel output. |
| XCH-E3 | Medium | test/helpers/jupyter.ts:74,87; test/exchange.test.ts:118,181 | Closed: observed exact owned container absence after success, cell error and actual 30-second timeout; fallback removes only observed test-owned identities. |
| XCH-E4 | Low | test/exchange.test.ts:179 | Closed: the actual raw-R cell under Python must emit SyntaxError; dependency absence is not the oracle. |

Actual evidence: `exchange-review-integrated-tests.log` (five PASS), `exchange-review-current-diagnostics.json` (PASS), `exchange-review-restored-mutations.json` (six detections and exact source restoration). The latter retains a failed harness conclusion: native Green correctly refused an oracle-helper change. `exchange-review-native-recovery.json` records successful production-only assertion Red and restored Green with the complete current oracle unchanged. No failure receipt was discarded.

Review closure does not establish current prerequisite/task receipts, full-project gate, product completeness or publication approval.
