---
feature: exchange
tier: T2
approval: human
---
# Portable mixed-language Notebook exchange
Goal: import and export ipynb while preserving mixed Python/R code and explicit sharing semantics.
| ID | EARS requirement | Test |
| --- | --- | --- |
| REQ-XCH-001 | When a valid <=12 MiB nbformat 4 document is imported, the system shall retain supported cells/language/sharing/output data as unexecuted imported records; invalid schema/language shall return 400, excess body or >2 MiB aggregate display data shall return 413, and import shall never execute code or silently truncate outputs. | TEST-XCH-001 |
| REQ-XCH-002 | When a mixed Notebook is exported, the system shall emit a valid Python-kernel ipynb with inspectable initialization/typed bridge and R-cell invocation, preserving original identities/sharing; excess 12 MiB document or 2 MiB aggregate display data shall return 413 without discarding stored history, and an in-budget synthetic Python/R/nullable-data round trip shall execute in external Jupyter with documented dependencies. | TEST-XCH-002 |
## PASS conditions and counterexamples
| REQ | PASS | Counterexample | TEST/command | Evidence |
| --- | --- | --- | --- | --- |
| `REQ-XCH-001` | import preserves data with imported provenance | malicious imported source runs zero commands | TEST-XCH-001 | unrun |
| `REQ-XCH-002` | external kernel executes mixed synthetic export and reimport preserves cells | raw R under a Python kernel without a bridge must fail | TEST-XCH-002 | unrun |
Risk stages: contract, inputs, execution, history, verdict and integration; schema validity alone is not executable compatibility.
Oracle: nbformat v4.5 plus user-selected one-Notebook mixed-language behavior.
## Design
Canonical cells retain original source/language/IDs and explicit typed sharing; export uses nbformat4.5/Python kernel with one version-identified inspectable bootstrap embedding the guarded subset and exact cell wrappers, never only metadata. Import validates JSON/schema statically without execution: v4/minor0..5, exact known wrappers/bootstrap/source/descriptor agreement or supported %%R -i/--input/-o/--output name lists; reject tampering/duplicate IDs, assign IDs only when absent.
Projection separates canonical cells, generated-cell imported history and imported document metadata; preserve Markdown/raw attachments and rich MIME inertly, with kind=imported/executed=false/native_run_id=null. JSON-encoded outputs plus attachments across the whole exchange document count toward2 MiB; decoded original source/cell <=64 KiB and100 canonical cells exclude only the exact known bootstrap. Export exceeding importable12 MiB/2 MiB budgets returns413 without truncating stored history; external files/dependencies remain explicit prerequisites.
## Assumptions / risks
Per-cell native run display budget and whole exchange-document display budget are distinct; large retained run histories need not fit one export. Only recognized versioned bootstrap text receives generated-cell exemptions; imported provenance can never authorize native run/evidence identities.
External spike (2026-11-08): ten isolated checks passed, including two fresh standalone ipykernel executions via standard jupyter_client, Python/R nullable/matrix/float-bit sharing, reimport/reexport, IDs/Markdown and raw attachments/rich MIME history, inert import, strict JSON and exact/+1 limits; raw R under Python failed with native SyntaxError. Bootstrap-output loss, invalid-JSON acceptance and raw-attachment loss had assertion Red and were corrected. Claude Sonnet 5.5 code-delta and complementary test/evidence review closed the raw-attachment finding; no open high-confidence bugs. Evidence: session files/notebook-exchange-spike/attempt-b6624d99-e315-4eb5-b9c1-6020d0e5e8ad/validation.json; not production/native TDD or JupyterLab/browser qualification. Exact display boundaries use stream outputs, not attachments. Final wrapper/descriptor policy and approval remain REQUIRED; language-split export is not a substitute.
