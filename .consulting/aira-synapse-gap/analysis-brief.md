# AIRA / Synapseの不足機能調査

基本機能はMVPに補い、文献管理・Graph RAGなどは後続仕様に残します。コードの存在とテストの動作確認は区別します。

- 分析担当: Copilot
- 意思決定者: AI for Scienceサービスの要件決定者
- 決定期限: 指定なし。実装契約の承認前
- 成果物: Analysisと未承認の実装契約
- 状態: Ready for Handoff

## 決定する問い

要件決定者は、AIRAとSynapseの機能のうち、現行のlocalhost向けMVPに何を補い、何を後続段階へ残すべきか。

## 成功条件

参照cloneのcommitを固定し、コード・テストの根拠で不足を分類します。既存REQ IDを保ち、追加条件に固有のREQ/TEST IDを付けます。実装済みという表現や、参照先のアーキテクチャの持ち込みは避けます。

## 制約

| ID | 制約 | 根拠 | 影響 |
| --- | --- | --- | --- |
| CON-001 | localhost、認証なし、単独利用。Next.js/TypeScript/PostgreSQL、LLMはCopilot SDK | SRC-003 / SRC-004 | Entra ID、多人数、他provider、公開は後続 |
| CON-002 | コード実行・Notebook変更・研究データの外部送信は確認必須 | SRC-003 | 自動実行、自動索引化、任意MCP権限を導入しない |
| CON-003 | 基本機能はMVP、文献管理・Graph RAGなどは後続 | SRC-004 | 今回は3つのMVP仕様と後続仕様を追加 |
| CON-004 | References/はignored、cloneは変更せず、参照先のスクリプトとテストは実行しない | 調査方針とclone検査 | 動作・性能・精度の保証には使わない |

## 情報源

| ID | 情報源 | 種別 | 取得日 | 限界 |
| --- | --- | --- | --- | --- |
| SRC-001 | References/aira、f59dd41972253c85f91b966c46cba4fbde9507e0 | Fact source | 2026-11-08 | 静的なコード・テスト確認。実行未確認 |
| SRC-002 | References/aira-synapse、837c2f21188d74413f1fba169cbc8c397c1d3e8b | Fact source | 2026-11-08 | CLI/MCPとライブラリ。Webアプリの実装ではない |
| SRC-003 | 調査開始時の12仕様・39要件。workspace/chat/provenance/dataの該当条件と当時のmvp-handoff.json | Context | 2026-11-08 | 未承認。workspace原文はセッション内aira-reference-review/workspace/prose-original.md、chat/provenance/data原文はaira-reference-review/baseline-contracts/に保持。現在の仕様とは区別する |
| SRC-004 | ユーザー回答: basic-mvp-advanced-later | Fact source | 2026-11-08 | 対象段階の回答。個々の仕様hashの承認ではない |

workspaceの改訂前SHA-256は7c6fcd002fbc5971e8b658e3cb0ed7ffc880712eb84f1c96781539685ab659daです。これはGit commitではなく、保持した原文の内容hashです。

## 未確認事項

| ID | 未確認事項 | 判断への影響 | 確認担当・時点 |
| --- | --- | --- | --- |
| UNK-001 | MathML変換・サニタイズの資源上限とブラウザ挙動 | 表示機能の設計承認には実機spikeが必要 | 実装担当、承認前 |
| UNK-002 | 参照解決と検査の完全な履歴・同意テスト | 実装完了とは判定できない | 実装担当、TDD時 |
| UNK-003 | 型共有、中規模転送、外部Jupyterの既存追加spike | 今回の静的調査では解消しない | 実装担当、承認前 |
| UNK-004 | 後続のembedding、PDF変換、graph保存方式 | Graph RAGをMVPから外す判断は完了。後続設計は未決定 | 要件決定者、後続着手前 |

## 使用する枠組み

Issue Treeで機能を分け、Hypothesis–Evidence–Falsificationで根拠と限界を管理し、Current–Target–Gapで仕様の追加先を決めます。数値による製品順位付けはしません。
