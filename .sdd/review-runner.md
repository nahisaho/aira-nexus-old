SPEC-01|high|.sdd/specs/runner.md:10|Fixed: explicit nonroot/no-new-privileges policy and writable bounded tmpfs, no host mounts.
SPEC-02|high|.sdd/specs/runner.md:25|Fixed in contract: cap serialized JSON response at 2 MiB; supervisor stops exact container on timeout/cap failure; implementation pending.
SPEC-03|medium|.sdd/specs/runner.md:25|Fixed in contract: 504 timeout, 413 output overflow, 503 unavailable; cleanup mandatory.
EXP-05|high|.sdd/specs/runner.md:24|Clarified: staged input occupies workspace tmpfs, not extra memory; tmpfs/process/buffers share 2 GiB cgroup. Real medium-transfer peak/OOM test still unrun.

## Implementation review

The lines above are historical design-review evidence, not current implementation
completion claims. Frozen manifest: session `files/runner-review-manifest1.json`.
Independent reviewers: Claude Sonnet 5.5, state/lifecycle and conversion/worker
wire-contract axes.

| ID | Severity | Evidence | State | Finding |
| --- | --- | --- | --- | --- |
| RUN-S1 | Medium | `src/server/runtime.ts` stop/restart paths, candidate1 | Closed, candidate2 | Clear rejected cached stops and permit explicit same-epoch cleanup retry; actual fail-once Docker regression detects the missing fix. |
| RUN-S2 | Medium | `src/server/runtime.ts` terminal error handling, candidate1 | Closed, candidate2 | Preserve durable terminal failure and inert replay through secondary projection/publication/cleanup failures; retain unknown cleanup explicitly. |
| RUN-T1 | Test gap | `test/helpers/bridge-contract.py`, candidate1 | Closed, candidate2 | Actual kernel rejects changed R shape/columns and preserves original destination/schema. |
| RUN-S3 | Medium | `src/server/runtime.ts:505-524`, candidate3 | Closed, candidate3 | Best-effort stop all owned kernels, drain tasks, remove exact IDs independently and aggregate failures; shared close promise permits retry while uncertain authority remains. |

Actual native regression Reds for RUN-S1/S2 are retained in session
`files/runner-review-TEST-RUN-001-red.log` and
`files/runner-review-TEST-RUN-003-red.log`.
Actual RUN-S3 regression Red and restored native Green are retained in
`files/runner-close-TEST-RUN-001-{red,green}.log`. Candidate3 is frozen in
`files/runner-review-manifest3.json`; the state reviewer closed S3 against that
snapshot. A final focused round also inspects the two-kernel regression.
The contract reviewer completed Node wire-client, stage/harvest and physical
isolation coverage in candidate2, with no significant finding. Candidate3's
canonical-base64 and final-hash rejection deltas were independently clean.

Actual integration exercised isolated Docker/Jupyter/rpy2, terminal publication
serialization, cancellation, timeout, output limit, OOM, selected-byte transfer,
and a generated 256 MiB Float64 guarded roundtrip alongside 256 MiB selected
inputs and 256 MiB harvested outputs. The generated numerical fixture is not
an interpretation of those selected bytes. This is not arbitrary-workload
capacity or completion evidence for the other three historical capacity fixtures.
Native task verification, current full-plan consistency and the full gate remain
pending. The failed expiry test setup and failed shared-task verification remain
preserved; neither is counted as a pass.
