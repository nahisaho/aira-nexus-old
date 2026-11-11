# Markdown authoring adoption review

Scope: immutable integrated-source candidates2/3; Claude Sonnet5.5 independent contract/data reviews. Specification readiness is not implementation qualification. Existing production behavior was not changed during reverse specification.

| ID | Severity | Location | State |
| --- | --- | --- | --- |
| MD-BOM | High | src/lib/markdown-metadata.ts:117-139 | OPEN implementation: two real BOM assertion counterexamples fail; preserve encoding prefix at byte0 and exact body after approved TDD |
| MD-EVIDENCE | Medium | .sdd/specs/markdown-authoring.md:18-20 | Spec fixed; pending reviewer closure: historical GUI claims removed from evidence cells |
| MD-LEGACY | Medium | src/components/notebook-editor.tsx:200-210 | Spec clarified; pending closure: first-save legacy adoption, first-tracked timestamp, exact unchanged tracked source |
| MD-BASELINE | Medium | src/lib/markdown-metadata.ts:95-96 | Spec clarified; pending closure: saved managed history wins over valid draft edits; invalid YAML still errors |
| MD-UPLOAD | Medium | src/lib/markdown-metadata.ts:135 | Spec clarified; pending closure: each explicit upload appends without a saved baseline, including unchanged input |
| MD-PREFERENCES | Medium | src/components/appearance.tsx:56-58 | Spec clarified; pending closure: missing name migrates valid preferences, invalid stored object resets atomically with error |
| MD-UNIT | Low | .sdd/specs/markdown-authoring.md | CLOSED contract: actual probe confirms80 Unicode code points; earlier unexecuted UTF-16 assumption was wrong; stricter HTML typing documented |

Actual evidence: session `integrated-markdown-observation.log` has3 passing utility assertions; `integrated-markdown-bom-observation-red.log` records two synthetic counterexamples and an actual assertion failure. Neither is native Red/Green or a GUI receipt. Native plan check `integrated-current-plan-check.json` is FAIL: all22 tasks require revalidation/replanning. No expanded gate or release qualification has passed.

## Expanded adoption: candidate6 specification readiness

Spec: `.sdd/specs/markdown-authoring.md`; SHA256 `1ca8dd6afe77d1305bbd0bbcfb90b8bce4b1ba5843f515b70dd613906da8e314`.
Independent Claude Sonnet5.5 agent: `a6c78550-93c1-4201-b28d-e95672a3bab7`; final bounded contract verdict: ready for exact-spec approval, not source qualification. Immutable manifest: session `integrated-source-manifest6.json`.

Contract findings: closed in reviewed fix delta. Implementation/evidence: OPEN — MD BOM preservation defect remains OPEN; native Red/Green and full GUI evidence pending; stricter HTML typing is documented.
Human exact-hash approval and expanded frozen qualification remain pending. Historical review sections are preserved below/above and do not qualify this source.
