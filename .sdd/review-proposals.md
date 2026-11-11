EXP-02|high|.sdd/specs/proposals.md:13|Fixed in draft: atomic grant/job/receipt transaction, scoped request uniqueness, post-expiry retry receipt and changed-fingerprint/new-ID conflicts.

## Implementation review

The original draft finding above is historical. Implementation review uses frozen
`proposals-review-manifest1.json` and `proposals-review-manifest2.json` in session
`1939ceaf-4688-40ce-abee-e605d5825a45/files`, not mutable working-tree snapshots.
Both independent risk axes use Claude Sonnet 5.5.

F1|medium|test/proposals.test.ts|Closed: actual stale/canonical/archive/accepted-rejected proposal controls; real guard-bypass Red and current native Green; contract reviewer closed candidate2 test delta.
F2|medium|test/proposals.test.ts|Closed: foreign disclosure admission, mixed-source receipt, expiry and changed-source refusal; owned immutable-result fault injection restored in finally; actual snapshot-comparison Red and Green.
PROP-T1|medium|test/proposals.test.ts|Closed: actual PostgreSQL expired-grant query and consume-time expiry-to410 mapping, controlled same-transaction injection, no job committed; independent state reviewer closed candidate2.
PROP-T2|medium|test/proposals.test.ts|Closed: purpose-swapped and fingerprint-swapped grants refuse409 and restore in finally; actual purpose-bypass Red and current Green.
PROP-T3|low|test/proposals.test.ts|Closed by existing evidence: initial receipt snapshot equals sealed preview; independently decoded replay equals original receipt after source edit/archive/expiry. Reviewer confirmed no missing failure mechanism.

Initial state review omitted the spec/test reads and was explicitly incomplete.
The same reviewer subsequently read those exact missing inputs before findings
were resolved; its first response alone is not a clean feature review.
Candidate2 has no production-source changes from candidate1, only stronger
assertions. Current four native Greens and TypeScript/ESLint diagnostics pass.

## Qualification scope

Execution preparation creates a logical, server-owned epoch/image reservation,
not a ready kernel. Actual Python/R execution, runtime recovery and serialization
through terminal publication and Notebook projection remain Runner requirements.
Observed result production and the disclosure dispatch consumer in these tests
are explicitly synthetic; actual SDK sending remains Chat work. Admission only
queues an authorized job and returns its sealed receipt.

The legacy public Operations grant remains capped at one minute. Its new guarded
in-transaction helper supports the already-approved five-minute confirmations.
Both grant issuance and admission helpers reject non-owned/non-active clients.
Disclosure uses the chat job purpose plus its distinct sealed `disclosure` kind;
execution and disclosure cannot substitute their grants or original receipts.

Full project gate has not been rerun or passed at this feature boundary. Actual
restored-mutation qualification and current native task receipts are recorded
separately; plan consistency alone is not implementation completion.

## Mutation refinement

The first 31-case round is preserved as FAIL: the trim mutation survived because
its input had no leading/trailing whitespace. The 32 KiB UTF-8 golden now
contains both, without changing its byte boundary. An actual assertion Red
reproduced the trim defect; restoring production code produced Green. All four
affected disclosure mutants were actually rerun and detected, with exact source
restoration. The other 27 cases use byte-identical own oracle regions and common
setup; their original whole-file hashes remain recorded, never relabelled.
`proposals-qualified-mutation-evidence.json` proves this exact one-literal
transformation and unchanged production sources against frozen manifest3.

Final bounded reviews found no new findings: the contract axis checked the
one-literal whitespace delta and actual Red log; the state axis independently
checked manifest invariance and the 27+4 qualification script/evidence. Neither
claimed to rerun tests. Prior findings remain closed; clean production source
was not repeatedly re-audited.
