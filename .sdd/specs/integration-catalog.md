---
feature: integration-catalog
tier: T2
approval: human
---
# Inert co-scientist selection catalog
Goal: shared fixed registry with per-project saved selections, not extension execution; user selected approved-catalog and skills-mcp.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-CAT-001 | When integration settings are opened, the system shall expose the fixed co-scientist catalog from nahisaho/aira commit f59dd41972253c85f91b966c46cba4fbde9507e0, containing the 203 discovered SKILL.md entries and ToolUniverse MCP definition with source paths/revision, and expose an empty Agents list rather than inventing missing definitions. | TEST-CAT-001 |
| REQ-CAT-002 | When the owner saves a project's catalog selections with its current independent settings revision, the system shall atomically persist only unique known category-matching IDs under that owned visible active project, retain selections through hide/restore and reload/from another client, and return 400 for invalid/duplicate IDs/input or any Agent ID, 404 for absent/foreign/hidden projects or 409 for stale/archived changes. | TEST-CAT-002 |
| REQ-CAT-003 | While catalog selections are displayed or saved, the system shall label them as not applied to chat, perform no external connection/download/command/Agent/Skill execution, accept no credentials or arbitrary server/host-path configuration, and leave the existing deny-default SDK permissions and research disclosure confirmations unchanged. | TEST-CAT-003 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-CAT-001` | exact pinned paths/count and MCP reference; searchable list supports all203; Agents array empty | README's inaccurate counts or nonexistent Agents treated as executable entries | TEST-CAT-001 | unrun |
| `REQ-CAT-002` | two-client persistence and valid empty selections; stale/unknown/duplicate inputs rejected | cross-project selection leak or lost concurrent update | TEST-CAT-002 | unrun |
| `REQ-CAT-003` | actual SDK session config remains deny-default after saved selections; browser makes no catalog-source requests | settings trigger MCP process/network, external Skill loading or credential storage | TEST-CAT-003 | unrun |
## Design
Bundle a sanitized metadata-only snapshot with upstream tree/blob identities and source revision; never install upstream AGENTS.md, instructions or Skills into this repository's agent configuration. Global registry is immutable in this iteration; checkboxes select entries per project, with read-only metadata details and no free-form configuration/import/update.
Persist project selection settings/revision through existing PostgreSQL owner/writer boundaries and bounded API JSON validation; settings have their own revision, while project row locks/visibility/archive fences still apply. Source metadata/command are inert display strings, never SDK configuration. Keep research-extensions execution/registration capabilities deferred.
## Assumptions / risks
Reference README claims202 Skills/2 Agents but actual tree has203 SKILL.md and no individual Agent files; tree evidence takes precedence. ToolUniverse is a catalog reference only, not a validated installed provider. No live sync or registration editing. Fixed-source snapshot validation and actual SDK/HTTP controls retire these assumptions.
