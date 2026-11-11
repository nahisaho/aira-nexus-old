SPEC-04|high|.sdd/specs/notebook.md:24|Superseded by user-approved gap scope: retain immutable run/output/artifact history on stale completion, return projection conflict 409 and stop affected kernel.
EXP-01|high|.sdd/specs/notebook.md:24|Clarified: valid confirmed execution snapshot is immutable; completed run and stale projection are independent states, not invalid execution.

## Implementation review and evidence
NOTE-R1-1|medium|src/server/notebooks.ts:178|closed|Actual assertion Red reproduced ir silently defaulting to Python; explicit language, known-name inference and ambiguity/unknown-name controls fixed and independently closed.
NOTE-R1-2|medium|test/notebook.test.ts:430|closed|Actual string-array source/stream controls, decoded UTF8 exact64KiB/+1 and both raw/Markdown attachments added and independently reviewed.
N2-1|medium|src/server/notebooks.ts:199|closed|Actual Red reproduced known kernel name contradicting language_info; all declarations share the conflict set; matching R triple remains valid.
NOTE-UUID|medium|src/server/provenance.ts:255|closed|Actual Reds reproduced valid UUID aliases rejected or leaking noncanonical identity; only validated UUIDs are case-folded, with runtime/snapshot IDs derived from owned records.

Independent reviewers: Claude Sonnet 5.5, state/publication and document/contract axes. Frozen manifests 1..4 and candidate directories are in the current session artifacts. Both axes independently closed the final manifest4 delta. The state axis completed its initially unread provenance/fence dependency scope in a separate bounded pass. Reviewers performed static review, not test execution.

All three native Notebook assertion Reds/Greens passed. The formatting-driven initial Green refusals remain preserved; fresh real Reds were recorded rather than waived. Final `notebook-mutation-results-round2.json` contains 31 assertion-detected bounded mutations, unchanged oracle hashes, individual logs and exact source restoration. All three native Greens were actually rerun after final restoration. Earlier round1's 27 mutations apply to the earlier pre-UUID candidate only.

A subsequent compiler check found one nullable test-fixture capture. Its sole operand was replaced with the immutable captured run's identical notebook identity; fresh native assertion Red/Green and the ten affected TEST-NOTE-003 mutations were rerun. `notebook-qualified-mutation-evidence.json` proves production source unchanged, the common header and TEST-NOTE-001/002 regions byte-identical, and combines their 21 unchanged-oracle cases with the ten current reruns. No historical whole-file oracle hash was relabelled current. Qualified diagnostics and the actual Next build then passed.

Tests use actual PostgreSQL, actual API request/response routing, real max-size documents and two exact-owned running containers to prove affected-epoch stop without stopping the unrelated container. Output/environment/count values come from a labelled synthetic producer, NOT actual Python/R scientific execution. Reopening the Notebook service preserves current source and immutable historical outputs/artifact links. The runtime interface is mandatory; no production no-op fallback is supplied.

The Runner task must prove one active run per notebook THROUGH terminal publication AND source-checked projection before busy release, including stale409 and every non-success terminal. This is pinned in the sole JSON plan; runtime scheduling/wiring remains unverified until Runner, not assumed complete by this feature.

The conservative native context remains INCOMPLETE for future planned shared owners. No scope weakening, empty-file workaround, repeated human approval, full-product gate PASS, live engine qualification or publication authorization is claimed.

## Expanded adoption: candidate6 specification readiness

Spec: `.sdd/specs/notebook.md`; SHA256 `f58394b071babc83173471f9a58fdf90c1e37ce1e289c18fbf23d9e232246c78`.
Independent Claude Sonnet5.5 agent: `653f314d-33dc-4b24-a9cf-600218161f76`; final bounded contract verdict: ready for exact-spec approval, not source qualification. Immutable manifest: session `integrated-source-manifest6.json`.

Contract findings: closed in reviewed fix delta. Implementation/evidence: OPEN — Individual Notebook carrier correction and current evidence pending; saved-history approval is separate and unchanged.
Human exact-hash approval and expanded frozen qualification remain pending. Historical review sections are preserved below/above and do not qualify this source.
