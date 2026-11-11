# AIRA / Synapse調査の引き継ぎ

MVPへは安全な科学Markdown表示、固定された計算引用、ローカル検査を追加しました。文献管理・Graph RAGなどは後続仕様に記録しました。いずれも未承認の契約で、Web機能の実装ではありません。

2026-11-08追補: ユーザーの「1プロジェクト1チャットに変更。」を受け、現在の正本は各プロジェクトに単一の永続チャットを持つ契約です。複数の名前付きチャットという以前の判断は置き換えました。Notebook・生成物・同意・復元の関連付けも単一チャットへ統一し、turnごとのSDK隔離は維持します。下記の調査結果とSRC-003は調査開始時の記録であり、最新のチャット契約は.sdd/specs/sessions.mdとchat.mdを参照してください。

- 意思決定者: AI for Scienceサービスの要件決定者
- 決定する問い: 参照先の何をMVPに補い、何を後続へ残すか
- 期限: 指定なし。仕様承認前
- 分析状態: Completed（静的調査と追加段階の判断）
- 信頼度: High（コードと契約の差）、Medium（表示資源・検査の実装可能性）
- 引き継ぎ先: sdd-spec-interview / lean-sdd-tdd。読者向け報告が必要な場合はtech-writer
- 省略した成果物: なし。数値による選択肢採点は不適用

## 発見と対応

| Finding | 論点・仮説 | 発見 | 根拠 | Gap/Intervention |
| --- | --- | --- | --- | --- |
| FND-001 | Q1.1 / HYP-001 | AIRAは数式を表示する。raw表示だけの開始時契約には不足 | EVD-001/EVD-003 | GAP-001/INT-001 |
| FND-002 | Q2.1,Q2.2 / HYP-002 | 引用と検査はprovenanceの保存と別の能力。cell-only引用の曖昧さは避ける | EVD-002/EVD-003 | GAP-002〜003/INT-002〜003 |
| FND-003 | Q3.1,Q3.2 / HYP-003 | Synapseは知識抽出・検索・federationを持つが、full経路のproviderとMarkdown CLIには注意が必要 | EVD-005/EVD-006/EVD-008/EVD-009/EVD-010 | GAP-004〜005/INT-004〜005 |
| FND-004 | Q4.1,Q4.2 / HYP-004 | 拡張管理・研究支援は元の後続構想を補えるが、広い権限や無確認改稿は移植しない | EVD-004/EVD-007/EVD-010 | GAP-006〜007/INT-006〜007 |

## 追加した契約

| パス | 状態 | 要件 |
| --- | --- | --- |
| .sdd/specs/scientific-rendering.md | MVP draft / T2 / human | REQ-RENDER-001〜003 |
| .sdd/specs/sources.md | MVP draft / T2 / human | REQ-CITE-001〜003 |
| .sdd/specs/research-checks.md | MVP draft / T2 / human | REQ-CHECK-001〜004 |
| .sdd/specs/research-extensions.md | deferred draft / T2 / human | REQ-EXT-001〜012、TESTは未割当 |

workspace.mdのDesignも表示切替との整合を取っています。既存REQ IDとraw表示・HTML/SVG download-only・外部media禁止は維持しました。開始時の12仕様・39要件に、10 activeと12 deferredを追加しました。現在は16仕様・61要件、うちMVPは15仕様・49 active要件です。

## 行動

| Action | 発見とGap/Intervention | 担当・時点 | 成功条件 |
| --- | --- | --- | --- |
| ACT-001 | FND-001〜004 / Q1.1〜Q4.2 / HYP-001〜004 / GAP-001〜007 / INT-001〜007 | Copilot、今回 | clone固定・不変・ignored検査、追加draft、ID/行数/構文検査 |
| ACT-002 | FND-001〜002 / Q1.1,Q2.1,Q2.2 / HYP-001〜002 / GAP-001〜003 / INT-001〜003 | 実装担当、承認前 | MathML/資源、固定引用、欠落証拠、送信拒否のspikeとテスト |
| ACT-003 | FND-001〜004 / Q1.1〜Q4.2 / HYP-001〜004 / GAP-001〜007 / INT-001〜007 | Copilotと要件決定者、実装前 | Claude Sonnet 5.5の独立delta review、正確な全path/hash/残存riskの人間承認、JSON plan |
| ACT-004 | FND-003〜004 / Q3.1〜Q4.2 / HYP-003〜004 / GAP-004〜007 / INT-004〜007 | 要件決定者、後続着手前 | deferredを分割し、具体的なprovider/adapter/権限/削除条件とTESTを承認 |

## 留保と証拠不足

UNC-001: 参照先のコード・テストは読んだだけで、アプリやテストは実行していません。READMEの精度・件数やPDF対応を実現証拠にしません。
UNC-002: 検査は数値と引用の関連、記録された実行状態、環境の有無を扱います。値の同一性、単位、科学的妥当性、実行済みseedを保証しません。
UNC-003: 新機能のnative TDD、browser/resource spike、既存の型共有・中規模転送・外部Jupyter spikeは未完了です。
UNC-004: .sdd/implementation-plan.jsonは未作成で、contextコマンドはSDD PLAN INCOMPLETEにより停止しました。plan/context/gateが通過したとは扱いません。
UNC-005: ユーザーのbasic-mvp-advanced-laterは対象段階の回答で、仕様hashの正式承認ではありません。

## 引き継ぎで保持するもの

CON/SRC/EVD/FND/GAP/INT/ACTの意味、参照commit、未承認/deferred状態、UNC-001〜005を保持してください。実装契約の正本は.sdd/specs/です。この分析を別の実装契約にしないでください。

References/airaとReferences/aira-synapseは変更しません。Next.js/PostgreSQL/Copilot SDK、確認必須、localhost限定を維持します。元のEntra ID・多人数・他provider・管理者機能は後続です。
