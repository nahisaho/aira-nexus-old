---
feature: runner
tier: T2
approval: human
---
# Confirmed container execution
Goal: stateful mixed Python/R execution without host execution or implicit file sharing.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-RUN-001 | When current source/revision/input/runtime identities have a valid one-use user confirmation, the system shall execute in a UID 1000 container with no network, read-only root, no-new-privileges, all capabilities dropped, 1 CPU, 2 GiB RAM and at most 128 processes; missing/malformed confirmation shall return 400, while supplied-grant conflicts/expiry follow proposals. | TEST-RUN-001 |
| REQ-RUN-002 | When Python/R cells explicitly share typed variables, the system shall preserve supported scalar/array/table type families, shape, column names and missingness; precision-losing or unsupported conversions shall produce visible cell errors without silently coercing values. | TEST-RUN-002 |
| REQ-RUN-003 | When execution exceeds 30 seconds, output exceeds 2 MiB, or restart is requested, the system shall stop that notebook's container and invalidate its runtime state without deleting notebook data. | TEST-RUN-003 |
| REQ-RUN-004 | When a runtime is initialized with selected owned file versions totaling at most 256 MiB, the system shall stage only those immutable bytes at unique safe names, harvest bounded output files in chunks, and reject foreign files, excess capacity or selection changes without restart. | TEST-RUN-004 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-RUN-001` | current purpose-bound grant and Docker inspect prove isolation | missing/malformed400, unknown/changed409, expired410 start no container | TEST-RUN-001 | unrun |
| `REQ-RUN-002` | supported Python/R-origin shaped/nullable values retain dtype, NA/NaN and exact float bits | out-of-range integer/Float32 drift/custom NaN/invalid Series label/schema-less R-character array rejects without replacing destination/schema | TEST-RUN-002 | unrun |
| `REQ-RUN-003` | timeout kills exact container | subsequent execution starts fresh | TEST-RUN-003 | unrun |
| `REQ-RUN-004` | selected CSV visible, unselected file absent | foreign artifact receives 404 | TEST-RUN-004 | unrun |
Risk stages: all; real network-disabled Python/R smoke required before approval.
Oracle: Docker isolation flags, Jupyter protocol and rpy2 explicit conversion.
## Design
At most two execution containers; guarded rpy2 bridge inside ipykernel; no host mounts/socket. Nosuid/noexec tmpfs: /tmp 256 MiB, /workspace 512 MiB; all tmpfs/processes/buffers share the 2 GiB cgroup. Reserve a new epoch without launching at preparation; after confirmed initialization capture observed environment before dispatching user code. OOM is visible 503, invalidates state and never triggers automatic replay/coercion.
30 seconds from user-code dispatch through terminal Jupyter response, including typed sharing; staging/harvest separately have120 seconds total per phase and10 seconds per unacknowledged chunk. Display <=2 MiB; files only from /workspace, <=100 MiB/file/256 MiB/run. Chunks <=512 KiB raw/1 MiB encoded bind transfer ID/offset/SHA-256/ACK; final length/hash gates publication, errors/timeout clean partials and invalidate state (504/413/503). Exact-ID cleanup; idle expiry10 minutes.
Guarded subset: Python bool/int/float/str, native-endian NumPy bool/integer/Float32/Float64/Unicode arrays/masked arrays, pandas Series/tables with unnamed default RangeIndex, None/string labels, unique string columns and corresponding nullable Int/UInt8/16/32/64, Float32/64, boolean/Python-backed string. Schema-less R integer/logical/double vectors/arrays and character vectors/table columns infer nullable Int32/boolean/Float64/string or shaped masked schema; R-origin character arrays refuse, unlike schema-backed Python Unicode array round-trips. Preserve shape/order/dtype/labels, NA versus NaN, exact representable float bits/signed zero/canonical quiet-NaN signs; nonmissing integers fit -2147483647..2147483647. Reject custom/signaling NaNs, NUL, object/complex/float16/byte strings, categorical/timezone/custom index/attributes and unmodeled metadata. Preallocate R storage, scan/write65536-element blocks and release each temporary mask; each conversion validates before replacing destination/schema. Masked-out backing bits and arbitrary user-code rollback are excluded.
## Assumptions / risks
Prior simple array/table and no-network spikes passed with rpy2 3.5.17/IPython 8.37.0. Raw converters lose nullable integer/logical masks and treat -2147483648 as R NA even when Python bytes round-trip unchanged.
Guarded sharing spike (2026-11-08, R 4.2.2/rpy2 3.5.17): 70 cases, both directions, changed R values/masks, four loss mutations and actual cell rejection with intact state passed; evidence: session files/typed-bridge-spike/attempt-97be1ccf and raw attempt-a7d0ca05. Not native TDD or full TEST-RUN-002 completion.
Capacity evidence: session files/transfer-memory-spike/attempt-c71e32b9-baa1-48e1-9b1c-f0e0d0382178 records original list-guard OOM and exact-ID 503 cleanup. Revised scratch guard passed 70 controls, four restored guard mutations, forward Float32 double-bit drift refusal, and four 256 MiB staged-input/output cases (Float64, shaped Float32, masked Float64, nullable Float64/Int64 table); cumulative whole-container peak 2082586624 bytes, oom_kill=0; session files/capacity-guard-spike/attempt-0b9f8b00-2c0c-43b7-ac3b-72c7143c2fc1/validation.json. Float32 values and the table's Int64 half are generated fixtures, not literal interpretations of selected bytes. Preallocation/block scans and per-mask Python/R temporary release are essential; whole-run ~62 MiB headroom is not an arbitrary-workload/all-dtype guarantee. Production bridge, final policy approval and native TDD remain REQUIRED; Docker has no kernel-exploit guarantee or runtime package installs.
