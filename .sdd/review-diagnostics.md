# Diagnostics review

The approved specification is unchanged. Current-session frozen candidate1 is
recorded in `diagnostics-review-manifest1.json`. Task qualification and the full
product gate remain pending.

| ID | Severity | Evidence | State |
| --- | --- | --- | --- |
| DIAG-D1 | Low | README described readiness without saying its route is not composed yet | Closed |
| DIAG-D2 | Low | README omitted the image-inspection command and non-reproducible-build caveat | Closed |
| DIAG-D3 | Medium | A generic infrastructure exception during lease probing was classified as a known lost lease | Closed |
| DIAG-D4 | Low | Negative-path role/redaction evidence was narrow | Closed with disclosed limits |

DIAG-D3 is demonstrated by the controlled infrastructure fault in
`diagnostics-lease-unknown-native-red.log`, not by stopping shared-host Docker
or another user's database. Known writer lease/fence failures remain blocked;
unclassified infrastructure failures are unknown and still never ready.
Both paths emit fixed metadata rather than exception text.
Same-oracle native Green is recorded in
`diagnostics-lease-unknown-native-green.log`; the unchanged backup oracle
genuinely refactored in `diagnostics-lease-shared-002.log`.

Actual native initial Red/Green exists for both requirements. The populated
source runtime/container/binding/reservation and canonical confirmation tests
have producer-mutation native Red, exact restoration, Green and shared-oracle
refactor in `diagnostics-authority-and-integrity-native.json`.
Candidate1 has 12 isolated assertion-detected, exactly restored mutants and
both tests passing in `diagnostics-current-restored-mutations.json`.
That snapshot does not cover subsequent DIAG-D3 source/test edits.
Frozen candidate2 has 13 current isolated assertion-detected, exactly restored
mutations, with both restored tests passing, in
`diagnostics-lease-fixed-restored-mutations.json`. Current TS/ESLint diagnostics
pass in `diagnostics-lease-current-diagnostics.json`; formatting and revised
README structural lint pass. The candidate2 manifest records exact bytes.

The Claude Sonnet 5.5 backup/restore state axis found no material defect in its
first frozen read. Its disclosed limitations are trusted local archive inputs,
retained partial destinations and the distinction between killing a Docker
client and proving an in-container dump process stopped.
Its second clean round checked the two script hashes against candidate1 and
carried forward its bounded conclusions; it did not re-read unchanged code.
The readiness/document axis actually read the D1-D4 fixes and returned two
clean fix-only rounds. These static independent reviews did not execute the
development tests or mutations. The README rubber-duck review converged;
English documentation requires no Japanese prose optimization.

Exact event-code/action constant assertions are not added as implementation
restatements. Missing CLI/image/socket, false/throwing auth, lost/unknown lease,
elevated role/membership/schema rights and credential/prompt sentinels cover
behavior. Docker availability is actually probed; shared-host Docker is never
stopped for a negative control.

## Expanded adoption: candidate6 specification readiness

Spec: `.sdd/specs/diagnostics.md`; SHA256 `29bd99cfb07bb4127294919614ecbc38001e61449f350fc42c8387fc74723c22`.
Independent Claude Sonnet5.5 agent: `653f314d-33dc-4b24-a9cf-600218161f76`; final bounded contract verdict: ready for exact-spec approval, not source qualification. Immutable manifest: session `integrated-source-manifest6.json`.

Contract findings: closed in reviewed fix delta. Implementation/evidence: OPEN — Settings-only explicit diagnostics requires current UI/native evidence.
Human exact-hash approval and expanded frozen qualification remain pending. Historical review sections are preserved below/above and do not qualify this source.
