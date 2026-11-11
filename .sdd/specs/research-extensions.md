---
feature: research-extensions
tier: T2
approval: human
---
# Research extensions: deferred, not part of the MVP
Goal: retain reference-derived capabilities for later decisions; the listed execution/registration features remain deferred. The separate integration-catalog contract permits only fixed inert catalog metadata and saved selections, not activation of these capabilities.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-EXT-001 (deferred) | When literature support is enabled later, the system shall manage project-scoped corpora/documents and versioned source metadata with explicit indexing/reindex/deletion jobs; PDF-to-Markdown conversion needs its own validated adapter. | — |
| REQ-EXT-002 (deferred) | When knowledge extraction is enabled later, the system shall retain passage/entity/relation/schema records, extraction provenance and confidence while distinguishing episodic observations, semantic facts and procedural schemas from verified scientific truth. | — |
| REQ-EXT-003 (deferred) | When Graph RAG is enabled later, the system shall support bounded hybrid vector/BM25 retrieval and multi-hop answers with source passages, disclosed omissions and explicit unavailable-provider errors. | — |
| REQ-EXT-004 (deferred) | When terminology support is enabled later, the system shall manage Japanese/English domain dictionaries and thesaurus relations with reviewed import/export and scoped query expansion. | — |
| REQ-EXT-005 (deferred) | When conflicting knowledge is detected later, the system shall preserve alternatives and their sources for human review rather than silently deleting or declaring one extracted assertion true. | — |
| REQ-EXT-006 (deferred) | When federated retrieval is enabled later, the system shall query only explicitly selected authorized corpora, namespace citations and disclose per-source timeout/failure, weighting and deduplication. | — |
| REQ-EXT-007 (deferred) | When graph inspection is enabled later, the system shall provide bounded project-scoped visualization and structured export without executing imported markup or traversing arbitrary host paths. | — |
| REQ-EXT-008 (deferred) | When Agent Skills management is enabled later, the system shall register/delete approved version-pinned Skills, assign them to projects and require explicit source/update approval for external repository synchronization. | — |
| REQ-EXT-009 (deferred) | When MCP management is enabled later, the system shall register/delete approved servers and expose project enablement with scoped tool permissions, secret-safe settings and confirmation before research data leaves the service. | — |
| REQ-EXT-010 (deferred) | When research review/templates are enabled later, the system shall support structured planning/review reports and proposed revisions without automatic source replacement or treating AI review as scientific approval. | — |
| REQ-EXT-011 (deferred) | When additional viewers/exports are enabled later, the system shall validate PDF/Office/molecular and bulk ZIP handling against content execution, resource exhaustion and unsafe archive paths before activation. Bounded inert Mermaid display is now specified separately by REQ-RENDER-005; interactive or unrestricted diagram features remain deferred. | — |
| REQ-EXT-012 (deferred) | When scientific connectors are enabled later, the system shall offer approved literature/database/cloud tools with disclosed external destinations, source attribution and least-privilege permissions. | — |
## Design
PostgreSQL ownership/version records and existing confirmation policies remain authoritative. A derived knowledge index is not a replacement for those records; graph storage, embeddings and PDF conversion are unresolved until activation.
Do not import reference CLI permissions, OpenAI defaults, host paths or automatic indexing into the MVP. Split activated capabilities into approved feature contracts with concrete tests and a new implementation plan before coding.
## Assumptions / risks
User selected basic-mvp-advanced-later on 2026-11-08; this is scope input, not hash approval. Reference code/tests were not executed; README PDF/local-only/benchmark claims are not implementation evidence. Entra ID, multi-user, other providers, publication and original admin goals remain later-stage work.
