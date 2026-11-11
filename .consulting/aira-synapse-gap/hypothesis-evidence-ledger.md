# 仮説と根拠

Factは、指定commitのコードまたはテスト本文で確認した事項です。テストファイルの存在を、実行成功の証拠にはしません。

## 仮説

| ID | 論点 | 検証する仮説 | 信頼度 | 反証条件 |
| --- | --- | --- | --- | --- |
| HYP-001 | Q1.1 | AIRAの数式付きMarkdown表示は、開始時のraw表示契約にない能力である | High | 開始時契約に同等の数式表示が明記されている |
| HYP-002 | Q2.1,Q2.2 | AIRAの引用検査は、既存のprovenance保存とは別の利用者向け能力である | High | 開始時契約に引用解決と検査レポートが明記されている |
| HYP-003 | Q3.1,Q3.2 | Synapseの知識抽出・検索能力は後続候補だが、現行MVPへの無条件の移植には制約がある | High | full機能が既存SDKだけで利用でき、権限・データ送信・保存方式にも差がない |
| HYP-004 | Q4.1,Q4.2 | AIRAの拡張管理は元の後続構想を具体化するが、MVPの自動ツール有効化を正当化しない | High | ユーザーが無確認実行やMVPの管理者機能を明示的に選ぶ |

## 根拠

パスはaira-nexusのrootからの相対パスです。SRC-001/SRC-002のcommitはanalysis-brief.mdに記録しています。

| ID | 仮説 | 方向 | 種別 | 情報源・行 | 確認内容 | 限界 |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | HYP-001 | Supports | Fact | SRC-001: References/aira/frontend/src/components/chat/markdown.ts:47-105; References/aira/frontend/src/components/chat/markdown.test.ts:30-62; References/aira/frontend/src/components/chat/MessageItem.tsx:36-65 | KaTeXのMathML変換、trust無効、4種の区切りと関連テストがあり、チャットから呼ばれる | Mermaidの後段SVG挿入などまで安全性を保証しない |
| EVD-002 | HYP-002 | Supports | Fact | SRC-001: References/aira/backend/src/services/provenance-validator.ts:24-56,119-155,170-205; References/aira/backend/src/services/provenance-validator.test.ts:147-165; References/aira/backend/src/services/notebook-trace.ts:54-85; References/aira/backend/src/routes/projects.ts:120-139 | 数値候補、cell引用、seed・環境等の検査とAPIがある。traceは最新snapshotを使う | 数値近傍やseed記述はヒューリスティック。最新cell参照を固定run参照として扱わない |
| EVD-003 | HYP-001,HYP-002 | Supports | Fact | SRC-003: 保持した改訂前workspace.md:12,21-23; baseline-contracts/provenance.md:10-12; baseline-contracts/chat.md:12,23; baseline-contracts/data.md:12（セッション内の原文保管先はanalysis-brief.md参照） | raw表示、固定実行・file版、狭いtool権限はある。利用者向け数式表示・引用解決・検査は未定義 | 開始時点の4関連契約の比較。現在の改訂仕様や製品実装の検査ではない |
| EVD-004 | HYP-004 | Supports | Fact | SRC-001: References/aira/backend/src/routes/skills.ts:15-70; References/aira/backend/src/routes/mcp.ts:10-82; References/aira/backend/src/services/paper-review.service.ts:15-39; References/aira/frontend/src/components/chat/MarkdownContent.tsx:25-64 | Skills登録/削除/割当、MCP編集/有効化、査読用prompt、Mermaid表示の経路がある | 自動改稿や任意MCPの権限を採用する根拠にはしない |
| EVD-005 | HYP-003 | Supports | Fact | SRC-002: References/aira-synapse/packages/memgraphrag/src/application/indexing/FullDocumentIndexingPipeline.ts:20-31,67-169; References/aira-synapse/packages/memgraphrag/src/application/query/QueryService.ts:28-97,145-163; References/aira-synapse/packages/memgraphrag/src/application/query/HybridMemoryFilter.ts:37-107 | passages/facts/schemas、schema安定化、矛盾処理、vector登録、出所付き回答の型、vector/lexicalのRRF統合moduleがある | 抽出factは真実の保証ではない。runtimeでの動作や全moduleの接続は未確認 |
| EVD-006 | HYP-003 | Supports | Fact | SRC-002: References/aira-synapse/packages/memgraphrag/src/application/indexing/DeleteDocumentService.ts:22-76; References/aira-synapse/packages/memgraphrag/src/interface/mcp/toolSchemaCatalog.ts:73-89,110-149 | corpus、索引job、文書削除、dictionary/thesaurus/conflict等の操作を定義する | 複数storeの原子性や削除の正しさを動作検証していない |
| EVD-007 | HYP-003,HYP-004 | Neutral | Fact | SRC-002: References/aira-synapse/packages/memgraphrag/src/interface/mcp/toolSchemaCatalog.ts:37-71,73-89; SRC-001: References/aira/README.md:112-166 | 日英の用語/同義語schema、graph exportなどのcatalogがある。科学DB・追加viewerはAIRA READMEの列挙 | READMEの件数や各DB/viewerの動作は未検証 |
| EVD-008 | HYP-003 | Supports | Fact | SRC-002: References/aira-synapse/packages/memgraphrag/src/application/query/FederatedQueryService.ts:78-148; References/aira-synapse/packages/memgraphrag/tests/application/FederatedQueryService.test.ts:75-164,203-222; References/aira-synapse/packages/memgraphrag/tests/application/DefaultRRFMerger.test.ts:81-207 | embeddingを1回計算し、複数DBの結果をnamespace/RRFで統合。部分失敗・全失敗・重複排除のテスト本文がある | mock中心のテストを読んだだけで、実DB間の動作は未確認 |
| EVD-009 | HYP-003 | Supports | Fact | SRC-002: References/aira-synapse/packages/memgraphrag/src/interface/cli/registerIndexCommand.ts:10-32; References/aira-synapse/packages/memgraphrag/src/interface/runtime/MemGraphRagRuntime.ts:108-126,345-381; References/aira-synapse/README.md:47-71 | このCLI経路はMarkdownのみ。full経路はOpenAI LLM/embeddingを構成し、localOnlyは機能未構成providerとminimal pipelineを使う | READMEのPDF quick-startや完全ローカルという読み方は、この実装経路だけでは裏付けられない |
| EVD-010 | HYP-003,HYP-004 | Supports | Fact | SRC-004: ユーザー回答 basic-mvp-advanced-later、2026-11-08 | 基本機能のみMVPへ入れ、文献・Graph RAGは後続とする判断 | 仕様hashや設計・実装の承認ではない |
| EVD-011 | HYP-001,HYP-002 | Neutral | Interpretation | EVD-001/EVD-002/EVD-003 | 安全な表示切替、固定run引用、ローカル検査を補うと、既存制約と研究用途を両立しやすい | 解釈であり、利用者効果の実測値ではない |

## 判定と留保

| 仮説 | 状態 | 根拠 | 次に必要な検証 |
| --- | --- | --- | --- |
| HYP-001 | Supported | EVD-001/EVD-003 | MathML/サニタイズ/資源上限のbrowser spike |
| HYP-002 | Supported | EVD-002/EVD-003 | 不明な引用、過去run、欠落環境、送信拒否のnative test |
| HYP-003 | Supported | EVD-005/EVD-008/EVD-009/EVD-010 | 後続着手時にprovider/PDF/graph方式を選び、実機検証 |
| HYP-004 | Supported | EVD-004/EVD-010 | 管理者・権限仕様の正式承認後に拡張契約を分割 |

ASM-001: 表示上限や検査grammarの具体値は設計仮定です。承認前spikeで実装担当が検証します。
ASM-002: セル引用が近くにあることやseed記述があることは、値の一致・実行済みseed・科学的妥当性を示しません。検査はこの限界を常時表示します。
ALT-001: PDF quick-startと実際のMarkdown CLIには差があります。変換adapterを未検証の後続条件として残します。
ALT-002: AIRAの自動改稿・MCP利用やSynapseの矛盾によるfact無効化は、今回の確認必須方針へそのまま持ち込めません。
