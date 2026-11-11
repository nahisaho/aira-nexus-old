# Scientific rendering review

Approved specification remains unchanged. Reviews use frozen candidate manifests
in the current session's `files/` directory, not an unfrozen repository scan.

| ID        | Severity | Evidence                                                                                                                 | State  |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------ | ------ |
| RENDER-W1 | High     | `src/server/scientific-rendering.ts:102-124`: cleanup failures reject directly; unexpected parser failures await cleanup | Closed |

Candidate 1: worker/lifecycle axis (Claude Sonnet 5.5) identified RENDER-W1.
Candidate 2: both independent axes completed two focused clean rounds; the worker
reviewer explicitly closed W1. Frozen hashes: `rendering-review-manifest2.json`.

Actual evidence in the current session's `files/` directory:

- `rendering-cleanup-native-red.log` and `rendering-cleanup-native-green.log`:
  identical regression oracle rejects termination failure, still-live uncertainty
  and unexpected parser cleanup failures explicitly instead of hanging.
- `rendering-cleanup-restored-mutations.json`: both new failure mechanisms
  detected by assertions, exact source restoration, all three tests pass.
- `rendering-cleanup-diagnostics.json`: required type/lint providers pass.
- `rendering-qualified-scientific-rendering-verification.json`: retained refusal
  for shared test-file movement; unchanged TEST-RENDER-001/003 were then genuinely
  refactored, not given invented Reds or ignored.
- `rendering-qualified-current-scientific-rendering-verification.json`: actual
  current native task verification and receipt adoption pass.

All ten prerequisites were actually reverified after dependency changes. The
current eleven-task milestone qualifies 37/49 requirements, not the composed
Next application, full project gate or release.

## Expanded adoption: candidate6 specification readiness

Spec: `.sdd/specs/scientific-rendering.md`; SHA256 `44d54bce15b38d2950fcc939ea2e69e65e42980706c839d19ad2c2bd5bc05797`.
Independent Claude Sonnet5.5 agent: `87c4d455-ca19-4f3e-8a2c-435fda1d86d4`; final bounded contract verdict: ready for exact-spec approval, not source qualification. Immutable manifest: session `integrated-source-manifest6.json`.

Contract findings: closed in reviewed fix delta. Implementation/evidence: OPEN — Four-image cap and expanded Mermaid budget/temporary-DOM cleanup assertions are PLANNED; no current native/GUI qualification.
Human exact-hash approval and expanded frozen qualification remain pending. Historical review sections are preserved below/above and do not qualify this source.
