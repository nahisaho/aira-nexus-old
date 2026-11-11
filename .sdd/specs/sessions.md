---
feature: sessions
tier: T2
approval: human
---
# One project, one chat
Goal: exactly one persistent chat per project, retaining its title editing but no extra chat creation, switching, branching or human-to-human chat.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-SESSION-001 | When a project is created, the system shall atomically create exactly one persistent chat for it; opening/reloading it or renaming that chat with a trimmed 1..120-character title shall reuse its ID/history, never allocate a second chat, and reject invalid titles with 400. | TEST-SESSION-001 |
| REQ-SESSION-002 | When Copilot emits partial response or tool/proposal events, the system shall display them as in-progress and commit a completed response only after a successful terminal event; cancellation or interruption shall remain visibly non-complete. | TEST-SESSION-002 |
| REQ-SESSION-003 | When constructing an outbound turn, the system shall include only the owned project's single chat's bounded history and explicitly consented file/result excerpts, disclose omitted history, and never automatically send complete research files or Notebook outputs. | TEST-SESSION-003 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-SESSION-001` | project creation creates one chat; concurrent opens/reloads and valid rename retain its ID/history | failed creation leaves neither row; duplicate allocation rejects; empty/121-character title returns 400; no extra-chat/switch controls | TEST-SESSION-001 | unrun |
| `REQ-SESSION-002` | partial reply becomes final only on success | dropped connection never marked complete | TEST-SESSION-002 | unrun |
| `REQ-SESSION-003` | approved excerpt appears once | another project's history or unselected file absent | TEST-SESSION-003 | unrun |
Risk stages: inputs, execution, verdict, history and integration; public contract is explicit.
Oracle: user instruction "1プロジェクト1チャットに変更。" (2026-11-08) and exact outbound disclosure.
## Design
Project -> one immutable chat ID -> turns, proposals and associated notebooks/artifacts. Every creation/restore path must preserve exact-one: mandatory project/chat creation transaction, UNIQUE(project_id), owned composite foreign keys and no independent chat create/delete/move API. Reads never manufacture a replacement chat; a broken invariant is an explicit readiness/data error. Archive retains the chat read-only.
Bounded SSE events project only that project's chat's durable job; cancel cannot retract bytes already received by GitHub.
Initial title defaults to "チャット"; existing title editing targets only the project's single chat and follows archive read-only policy. Renaming never creates a conversation or clears its records.
History default: latest complete turns fitting 32000 characters; new prompt <=16000; approved excerpts <=32 KiB UTF-8. Warn on omitted history; context errors remain explicit.
## Assumptions / risks
The persistent project chat is distinct from fresh SDK sessions per turn. No branches or automatic summarization; no existing application database requires migration.
Database-only spike (2026-11-08, PostgreSQL 17.11): atomic rollback, UNIQUE rejection, 20 concurrent creates, 48 opens and retained history/title passed; four bounded mutations were detected.
Owned/foreign associations, both archive/admission lock orders and separate empty-DB restoration passed. Evidence: session files/single-chat-spike/attempt-222103b1/validation.json; this is not native TDD or full TEST-SESSION-001 completion.
UNIQUE alone guarantees at most one, not existence. Earlier DB-only host networking followed bridge-port failures; the later private Unix-socket candidate passed the same six cases with network-none/no TCP/ports (session files/database-transport-spike/attempt-97612fa1-7159-478b-b0d2-44c3e98375c8/validation.json). Production API/UI, SDK/consent and full runtime tests remain unrun.
