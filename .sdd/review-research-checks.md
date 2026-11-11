# Local advisory check review

The approved specification is unchanged. Frozen candidate1 and its baseline
are recorded by `research-checks-review-manifest1.json` in the current session's
`files/` directory. This is not a task receipt or a full gate.

| ID | Severity | Evidence | State |
| --- | --- | --- | --- |
| CHECK-N1 | Medium | A NUL-containing file passed preview but cannot be captured in PostgreSQL JSONB | Closed |
| CHECK-E1 | Medium | Execution report retained a generic metadata verdict but omitted the observed fields and explicit unavailable values | Closed |
| CHECK-L1 | Medium | `src/server/research-checks.ts`: normalized multiline inline-code content failed raw lookup, leaving the cursor behind; later prose could be mapped to identical text inside ignored code | Closed |

CHECK-N1 has genuine native assertion Red in
`research-checks-nul-native-red.log`, followed by explicit text rejection and
same-oracle Green in `research-checks-boundary-nul-green.log`.
Malformed UTF-8 is also rejected; exact 64-KiB ASCII/astral controls remain valid.
The four-active/fifth-refused capacity control has a restored producer mutant
and genuine native Red/Green in `research-checks-boundary-evidence.json`.

CHECK-E1 has actual native assertion Red/Green in
`research-checks-environment-native-{red,green}.log`; immutable reports retain
the captured environment, including nulls. Shared-file refactors genuinely ran.

Candidate1 has 19 isolated assertion-detected, exactly restored mutations and
all four restored tests passing in
`research-checks-current-restored-mutations.json`; diagnostics pass in
`research-checks-candidate-diagnostics.json`. These are candidate1 snapshots,
not proof that later-added counterexamples pass.

CHECK-L1 upgrades the evidence reviewer's initially low-confidence concern:
`` `prefix\n AUROC=0.83\nsuffix` AUROC=0.83 `` reports line2 inside code rather
than actual prose line3. The new real database test fails by assertion,
`2 !== 3`, in `research-checks-multiline-code-raw-red.log`.
Actual native Red preceded the production fix and same-oracle Green in
`research-checks-multiline-code-native-{red,green}.log`. Exact anchored cursor
mapping now consumes raw code delimiters and verified CommonMark normalization.
Unsupported paragraphs are explicitly omitted, including their run references;
no child is searched forward after an unmapped span. Later-line bold prose and
ignored link destinations retain explicit controls.

Frozen candidate2 has 20 current assertion-detected, exactly restored mutations,
including the old cursor failure, in
`research-checks-location-fixed-restored-mutations.json`; all four restored
tests and native shared-file refactors pass. Current diagnostics pass in
`research-checks-location-diagnostics.json`. The frozen candidate2 manifest
binds these actual bytes and evidence.

Claude Sonnet 5.5 lifecycle review completed two focused clean rounds, including
actual TEST-CHECK-004 and the migration registration. Its acknowledged oracle
limits are unforced concurrent overlap and no cross-version resumption of an
unfinished request. The evidence axis's first read was clean but CHECK-L1 is
was confirmed and repaired. Its two fix-only clean rounds actually read the
frozen candidate2 cursor/normalization delta and new counterexamples; no
material remaining defect was found. Reviews did not execute the tests or
mutations, which were independently executed by the development process.

Shared Operations/migration changes require actual prerequisite requalification.
`qualify-checks-prerequisites` completed all 12 actual verifications and adopted
only real passing receipts.
No current 44-requirement task qualification, Research task receipt, composed
Next workspace, full gate or publication approval is claimed.
