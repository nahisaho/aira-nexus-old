# 仮説とコード上の根拠

すべてのSRCは2026-11-08に確認しました。SRC-001〜SRC-009は同じ参照commitの証拠であり、独立した製品評価ではありません。SRC-010は調査開始時の未承認18要件です。各仕様は調査後に改訂されており、記載した行は現在の内容を指すものではありません。

## 証拠の所在

| ID | ファイル・行 |
| --- | --- |
| SRC-001 | `References/open-science/src/main/notebook/mcp-server.ts:1570-1607` |
| SRC-002 | `References/open-science/src/shared/notebook.ts:83-100,381-479`; `src/main/notebook/execution-owner.ts:619-667`; `src/main/notebook/run-terminalization.ts:205-246` |
| SRC-003 | `References/open-science/prisma/schema.prisma:938-990`; `src/shared/artifact-provenance.ts:47-80,163-173`; `src/main/notebook/environment-capture.contract.test.ts:23-108` |
| SRC-004 | `References/open-science/src/main/notebook/ipynb-export.ts:188-201,227-263`; `src/main/notebook/ipynb-export.test.ts:289-363` |
| SRC-005 | `References/open-science/src/shared/project-files.ts:3-31,41-65`; `src/main/notebook/input-staging.ts:37-80` |
| SRC-006 | `References/open-science/src/shared/conversation-command-contract.ts:5-35`; `src/shared/projects.ts:14-35,43-59` |
| SRC-007 | `References/open-science/src/main/session-package/ro-crate.ts:83-139`; `src/main/session-package/sensitive-content.ts:10-30,60-92` |
| SRC-008 | `References/open-science/docs/PRD.md:30-35,62-70`; `docs/known-limitations.md:9-19,21-42,61-79` |
| SRC-009 | `References/open-science/prisma/schema.prisma:17-35`; `package.json:143-155`; `README.md:278-296` |
| SRC-010 | `.sdd/specs/projects.md:10-13`; `.sdd/specs/chat.md:10-13`; `.sdd/specs/notebook.md:10-12`; `.sdd/specs/runner.md:10-13`; `.sdd/specs/workspace.md:10-12` |

SRC内の2つ目以降の省略パスも、`References/open-science/` からの相対パスです。

SRC-010の調査時SHA-256は、承認対象を提示した時点の値です。元の仕様はGitに記録されておらず、これは原本の保存や現在の版の承認を意味しません。

| 当時の仕様 | SHA-256 |
| --- | --- |
| .sdd/specs/projects.md | e3d5b83d870329ad0b212082b361f87a3e4ffc27ae605607dcbcf57de8e6423f |
| .sdd/specs/chat.md | c5ad5263a00dc3a56ff2d0c48cd219ee197660241caefd733e1909b9af001d0f |
| .sdd/specs/notebook.md | 313e50d5ffce0b14a5e314044be02dc64d240c3439de96d6995a5cf44a230cfb |
| .sdd/specs/runner.md | 4f3284326161c4afc5dc14294bd8ee77faab174e92c79a813dcd2e781dc2bcc1 |
| .sdd/specs/workspace.md | 31ebf5a8a0b9ce691e501141f10b96cbd108928261d1f282d7fe0bbb7b796ba5 |

## 仮説

| ID | 論点 | 検証する主張 | 判断 |
| --- | --- | --- | --- |
| HYP-001 | Q2.1 | 調査時点のsave_file限定契約には、AIからNotebookへコードを渡す受入条件がない | Supported |
| HYP-002 | Q3.1 | 終了状態・要求ID・再試行規則を追加しないと、中断時の結果を一意に説明できない | Supported |
| HYP-003 | Q4.1 | 最新出力の保存だけでは、どの入力・環境が生成物を作ったかを追跡できない | Supported |
| HYP-004 | Q3.2, Q4.2 | 参照先の言語別exportは、要求された混在・変数共有の互換性を証明しない | Supported |
| HYP-005 | Q1.1, Q1.2 | 入力ファイルと会話の選択・容量には追加の契約判断が必要 | Supported |
| HYP-006 | Q2.2, Q5.1 | アーカイブ競合・復元・診断は、単一ユーザーでも定義が必要 | Supported |

## 証拠と解釈

| ID | 仮説 | 種別 | 方向 | 根拠 | 観測内容 | 信頼度・限界 |
| --- | --- | --- | --- | --- | --- | --- |
| EVD-001 | HYP-001 | Fact | Supports | SRC-001, SRC-010 | 参照先にnotebook_executeと結果参照のツール定義がある。調査時点のCHAT-003はsave_fileのみを許可していた | High。調査後、ユーザーは確認を経るAI操作を選択 |
| EVD-002 | HYP-002 | Fact | Supports | SRC-002 | queued/running/completed/failed/timeout/interrupted/cancelled、submissionIdentity、同一要求の再利用・異なる内容の競合処理がある | High。テストを実行した証拠ではない |
| EVD-003 | HYP-003 | Fact | Supports | SRC-003 | ArtifactVersionにproducerRunId、入力関係、checksum、実行snapshotがある。環境lockのchecksumを確認するテストがある | High。再現性や科学的妥当性を保証しない |
| EVD-004 | HYP-004 | Fact | Supports | SRC-004 | Python/R別exportのセル帰属をassertするテストがある。セルmetadataに言語・実行ID・時刻を保持する | High。同じNotebookでのrpy2変換成功の証拠ではない |
| EVD-005 | HYP-005 | Fact | Supports | SRC-005, SRC-006 | upload/artifactの入力版を区別し、会話BranchとMessageを一意に扱う。ProjectにagentContextがある | High。複数会話や分岐のMVP採用は別判断 |
| EVD-006 | HYP-006 | Fact | Supports | SRC-006, SRC-007, SRC-010 | 参照先の更新・archiveは世代値を要求する。packageのファイルhashを検査する。現行契約に復元の受入条件はない | High。完全なバックアップ機能があるとは断定しない |
| EVD-007 | HYP-003, HYP-004 | Fact | Weakens | SRC-008 | 参照先も、再実行による一致と科学的妥当性を区別し、コード確認を安全保証と扱わない | High。v1.1.0時点の文書上の制限 |
| EVD-008 | HYP-006 | Interpretation | Neutral | EVD-006 | MVPには簡素なPostgreSQLバックアップ・復元試験を採用し、独自package形式は延期できる | Medium。運用方式の推奨であり実装事実ではない |
| EVD-009 | HYP-001 | Interpretation | Neutral | EVD-001 | AIの提案をNotebookへ取り込む経路は必要だが、AIが実行要求まで出すかはユーザーに確認すべき | Medium。製品判断を事実と混同しない |

## 仮定と反証

| ID | 種別 | 内容 | 確認方法 |
| --- | --- | --- | --- |
| ASM-001 | Assumption | 機能数より、研究記録を失わず説明できることをMVPで優先する | 要件決定者の採用判断 |
| ASM-002 | Assumption | 当初の固定容量が実際の研究データに足りるかは不明 | 代表的なCSV・画像・Notebookで容量spike |
| ALT-001 | Counterevidence | 参照先は同時マルチユーザー編集を非目標としている | Entra ID・組織権限は別途設計する |
| ALT-002 | Counterevidence | 参照先の主要構成はElectron/SQLite/ACPであり、Copilot SDKではない | CON-001を維持し、仕様上の着眼点だけを利用する |
| ALT-003 | Counterevidence | 変換できる型と数値・欠損値の意味は、配列・表のspike成功だけでは確定しない | Python/R型変換の境界試験を追加する |

分析でSupportedとしたのは、追加の定義が必要という仮説です。追加機能の採用や、参照先の実行品質を承認したものではありません。
