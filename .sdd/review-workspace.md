# Workspace independent review

Scope: approved Workspace implementation, necessary shared startup/README/configuration
and canonical result-text delta. No specification changes or publication approval.

| ID | Severity | Location | State |
| --- | --- | --- | --- |
| WS-L1 | medium | scripts/start.ts:22-87 | Fixed; startup signal handlers are installed before asynchronous initialization, stop drains startup and no later stage opens HTTP after stop. |
| WS-L2 | medium | src/server/application.ts:335-343 | Fixed; runtime initialization drains before runtime close; initialization failures retain fixed diagnostic events. |
| WS-L3 | low | test/helpers/startup-signal.ts | Fixed; the controlled prepare barrier does not call real Next.prepare and needs no preexisting build; the real startup and handler-after-stop counterexample remain exercised. |
| WS-U1 | medium | test/helpers/workspace.ts, projectFlow | Fixed; actual completed chat, loaded destination absence checks, return/reload persistence. |
| WS-U2 | medium | test/helpers/workspace.ts, safetyFlow | Fixed; raw Notebook and file previews assert literal script text, separately from absence of executable script nodes. |
| WS-U3 | low | test/helpers/workspace.ts, archived fixture/safetyFlow | Fixed; actual archived pending proposal and disabled proposal/archive controls, in addition to chat/notebook/upload controls. |

Development: GPT-6.1 Sol. Independent reviewers: Claude Sonnet 5.5.
Frozen candidate: session `1939ceaf-4688-40ce-abee-e605d5825a45`,
`files/workspace-review-manifest6.json` and `workspace-review-candidate6`.
Lifecycle reviewer `f84fc8b0-171d-4e9f-8d63-f181446d0c9a`;
UI/oracle reviewer `d424eda3-1542-42af-a30c-608dd537cdaf`.

Actual proof is retained in the session files:

- `workspace-lifecycle-review-native-red.log`: real owned PostgreSQL initialization/close ordering assertion.
- `workspace-early-startup-assertion-red.log`: separate actual early-stop assertion after the first race fix.
- `workspace-lifecycle-review-native-green.log`: same-oracle native safety/lifecycle Green.
- `workspace-review-synchronized-001-native-green.log` and
  `workspace-review-synchronized-002-native-green.log`: current scope/confirmation Greens.
- `workspace-review-scope-synchronized-baseline-replay.json`: updated oracles replayed against the exact recorded preimplementation 503 baseline, implementation byte-restored.
- `workspace-literal-assertions-native-green.log`: current loaded literal-text and lifecycle native Green.
- `workspace-literal-assertions-diagnostics.json`: current TypeScript/ESLint PASS.

The initial rejection mutation was not assertion-proven: the database witness
raced asynchronous approval. Its failed log and restored source are retained,
not counted as a passing mutation. Rejection witnesses now await dialog closure.
Two subsequent raw-HTML mutants reached locator timeouts, not assertions, and
are not counted as mutation proof. Raw-content checks now inspect the loaded
preformatted text directly: absent expected text fails an assertion rather than
timing out while selecting on that same expected text.
Current isolated mutations and restored controls remain separate evidence.

Both scopes reached two clean independent rounds, including candidate5's
assertion-only UI oracle delta. The lifecycle scope carries forward unchanged.
`workspace-final-review-convergence.json` records exact agents, final turns and
the frozen manifest.

All eleven current isolated mutants were assertion-detected, all producer
sources restored byte-for-byte, and all three restored browser tests passed:
`workspace-literal-assertions-restored-mutations.json`.
Current production build and built-browser E2E passed. The first additional
startup smoke failed before execution because the external `.ts` fixture was
treated as CommonJS; the corrected `.mts` fixture passed, including unavailable
writer lock before stop and successful acquisition after graceful SIGTERM.
All 49 current native refactors passed. The external 30-minute batch recorder
then timed out after seven successful refreshed task receipts; this is retained
as a recorder failure, not a product test failure or a gate PASS.
The exact owned Runner verifier was allowed to finish normally and release its
lock. Its lost report is not adopted. A fresh native plan check confirmed eight
current tasks, including unchanged deferred-only documentation.

Resumed verification passed all 16 current task receipts. The first complete
native gate then passed locks, trace, ledger, planning, all 49 TDD bindings,
production preparation, typecheck and lint, but its full-suite test check
timed out after 120 seconds. There were 35 passing tests and no assertion
failures observed before interruption. The interrupted run is not a PASS.

Candidate6 adds only `checks[name=test].timeoutMs: 600000` in `.sdd/config.json`.
The global 120000 ms allowance, individual native tests, product deadlines,
commands, assertions and complete scope are unchanged. The lifecycle reviewer
independently confirmed the exact delta and unchanged-hash second round clean;
UI/source/oracle hashes are unchanged. Only three named fixtures born during
the timed-out gate and their four exact UUID-label-owned containers were
removed; `workspace-full-suite-timeout-owned-cleanup.json` retains the proof.

All 49 actual native refactors and all 16 task verifications passed against
candidate6. The complete native gate passed: 49 tests, 49 passed, zero failed,
cancelled, skipped or TODO; the full test check took 265.8 seconds. Typecheck
and lint passed. Fresh postgate native consistency confirms all 16 task
receipts remain complete and current. Historical receipts were not substituted.

Final evidence: `workspace-suite-envelope-{refactor-summary,verify-summary}.json`,
`workspace-suite-envelope-final-full-native-gate.log`, and
`workspace-suite-envelope-postgate-plan-check.json`. Approval locks remain valid;
the tool's implementation-since-approval warnings are retained without
inventing human reapproval. This is development qualification, not release or
publication approval. Deferred extensions remain inactive.

## Expanded adoption: candidate6 specification readiness

Spec: `.sdd/specs/workspace.md`; SHA256 `3ff976e8a7c0b7e64ade4ce81dfc2c8519ca23dd9923ea7ff94df548e5106603`.
Independent Claude Sonnet5.5 agent: `653f314d-33dc-4b24-a9cf-600218161f76`; final bounded contract verdict: ready for exact-spec approval, not source qualification. Immutable manifest: session `integrated-source-manifest6.json`.

Contract findings: closed in reviewed fix delta. Implementation/evidence: OPEN — Current source still has fixed ELN; correction and expanded per-viewer guards pending.
Human exact-hash approval and expanded frozen qualification remain pending. Historical review sections are preserved below/above and do not qualify this source.
