# Immutable sources review

The approved specification is unchanged. Frozen candidate:
`sources-review-manifest1.json` in the current session's `files/` directory.
Both Claude Sonnet 5.5 axes completed two focused clean code-review rounds.
Record-review citations were corrected from cumulative to per-file numbering;
its follow-up actually read the execution/edit/restart/new-run oracle.
The consent reviewer subsequently read TEST-CITE-003 itself and the byte-mutation
driver, without treating queued commands as executed proof.

| ID | Severity | Evidence | State |
| --- | --- | --- | --- |
| CITE-U1 | High | `src/components/source-reference.tsx`: a retained component displayed the previous project's fetched record after a project-only prop change | Closed |
| CITE-T1 | Medium | TEST-CITE-003 initially exercised 32772 bytes, not exactly 32769 bytes; a one-byte limit regression could escape that oracle | Closed |
| CITE-T2 | Medium | Isolated TEST-CITE-003 does not duplicate expired-grant coverage | Closed by current dependency coverage |

CITE-U1 has actual assertion Red/Green in
`sources-scope-card-native-{red,green}.log`. Identity-keyed child state and
abort-on-unmount remove the old preview without fetching on scope change.
The corresponding current mutation is assertion-detected and exactly restored.

`sources-current-restored-mutations.json` records nine current detections,
including file ownership in both metadata and selected bytes, run ownership,
latest-run rebinding, exact-cap rejection, scalar ranges, ambient expansion and
active SVG metadata. All three restored real tests pass. Diagnostics pass in
`sources-scope-card-diagnostics.json`.

The CITE-T1 oracle now selects exactly 32768 bytes of astral characters, followed
by one ASCII byte. `sources-exact-byte-restored-mutation.json` records actual
assertion failure under a one-byte producer-limit mutation, native Red, exact
source restoration, same-oracle native Green, genuine shared-file refactors for
the other two tests, and all three restored tests passing.

CITE-T2's focused review confirmed the actual TEST-CHAT-004 expired-grant update,
409 refusal and unchanged SDK count, on the same production
`Chat.submit -> Sessions.authorizedContext` path used by Sources. This is not a
missing global regression. Actual current Chat requalification passed in
`sources-prerequisites-chat-verification.json`.
Consumed-grant/new-request refusal is not independently asserted here. The byte
mutation weakens both defenses together; it proves end-to-end overflow detection,
not independent detection of weakening either redundant guard alone.

All ten affected prerequisite tasks have actual fresh passing receipts in
`sources-prerequisites-*-verification.json`. Sources has an explicit Runner task
dependency, three genuine unchanged-oracle refactors, current passing diagnostics
in `sources-runner-qualified-diagnostics.json`, and frozen candidate2.
`sources-qualified-current-sources-verification.json` is actual task PASS with
its adopted receipt; `sources-qualified-current-plan-check.json` confirms
12 current tasks and 40/49 active requirements.

The first qualification driver refused to overwrite old diagnostics output.
`sources-qualification-driver-output-collision.json` retains that refusal;
remaining stages ran with unique paths, without overwriting prior evidence.
No composed Next application, full gate, remaining nine requirements or
publication approval is claimed.
