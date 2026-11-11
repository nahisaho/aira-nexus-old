SPEC-05|medium|.sdd/specs/chat.md:25|Fixed: raw-byte uploads, no base64 expansion in the 12 MiB HTTP body budget.

# Production Chat review

Frozen manifest: session `chat-review-manifest1.json`; six production/test artifact hashes match `chat-candidate-handoff.json`. Independent Claude Sonnet 5.5 state-truth and SDK/tool-contract reviewers each returned two clean focused rounds, including actual controlled test-body reads in round two.
Reviewer IDs: state `fe28e813-8af6-46a8-9302-b8c29d6be38f`; SDK `d70524ba-ebe0-41a3-a959-473097605908`.

| ID | Severity | Location | State |
| --- | --- | --- | --- |
| CHAT-S | None | src/server/chat.ts:117,243; test/chat.test.ts:242,373,575 | Closed, no actionable state-truth findings. Controlled tests pin no resend, failed-event truth, unpublished-artifact isolation and cleanup unknown rather than fabricated success. |
| CHAT-T | None | src/server/copilot.ts:111,173; test/chat.test.ts:431,558 | Closed, no actionable SDK/tool-contract findings. Controlled helpers invoke captured production-wrapped handlers; exact 1 MiB emoji and +1 invalid controls are present. |

Non-blocking limits: an HTTP/read failure after committed completion can return an error while the durable receipt remains completed; same-intent retry recovers it without another SDK call. Tests do not separately pin every active-turn grant-only mismatch or SSE resume variant. Operations non-container cleanup remains honestly unknown; adapter cleanup must be confirmed before successful publication.

Evidence: `chat-candidate-handoff.json`, four current `chat-shared-ready-TEST-CHAT-*-native.log`, eight restored mutation records and genuine synthetic-only SDK reply/save_file proof. Production application/UI composition, current task verification and full-project gate are separate obligations.
