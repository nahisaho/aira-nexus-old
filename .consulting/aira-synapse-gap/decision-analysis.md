# 現状と追加先

ユーザーは基本機能をMVP、文献管理・Graph RAGなどを後続へ残す方針を選びました。数値スコアで製品を順位付けせず、既存契約とのGapを扱います。

| Gap | 次元・根拠 | 開始時の契約 | 目標と措置 | Intervention | 追加先 | 前提 |
| --- | --- | --- | --- | --- | --- | --- |
| GAP-001 | 研究内容の表示、EVD-001/EVD-003 | Markdownもraw表示 | 明示的な表示切替で安全なMarkdown/MathMLを読む | INT-001 | scientific-rendering、3 active REQ | workspace/data。raw HTMLと外部mediaは実行・取得しない |
| GAP-002 | 計算根拠への移動、EVD-002/EVD-003 | run/file版の保存はある | [run:UUID]/[file:versionUUID]で固定根拠を開く | INT-002 | sources、3 active REQ | provenance/data。cell-only参照は最新runへ補完しない |
| GAP-003 | 根拠不足の確認、EVD-002/EVD-003 | 履歴・環境を保持するが検査UIはない | 限定的な引用/実行/seed宣言の検査をローカルで記録 | INT-003 | research-checks、4 active REQ | sources/provenance。検査は科学的保証ではない |
| GAP-004 | 文献と知識検索、EVD-005/EVD-006/EVD-008/EVD-009 | 文献管理は後続、Graph RAG未定義 | corpus・抽出知識・hybrid/multi-hop・federation・graph表示を後続へ保持 | INT-004 | research-extensions、EXT-001〜003/006〜007 deferred | provider/PDF/graph保存、外部送信、削除の設計を再確認 |
| GAP-005 | 用語と矛盾、EVD-005/EVD-007 | 未定義 | 日英用語・thesaurus・矛盾レビューを後続へ保持 | INT-005 | research-extensions、EXT-004〜005 deferred | AIのfactを真実としない。代替根拠と人間判断を保持 |
| GAP-006 | 拡張管理、EVD-004/EVD-010 | Skills/MCP管理は元の後続構想 | 版固定・project割当・有効化と権限制御を補う | INT-006 | research-extensions、EXT-008〜009 deferred | 管理者認証、秘密情報、外部先と権限の承認 |
| GAP-007 | 査読・viewer・科学connector、EVD-004/EVD-007 | 一部は元の後続構想 | review/template、追加形式、科学DB/cloud連携を後続へ保持 | INT-007 | research-extensions、EXT-010〜012 deferred | 無確認の改稿・cloud操作・外部送信は許可しない |

担当は要件決定者と実装担当です。MVPの成功条件は各TEST IDで定義し、後続条件にはまだ実行テストを割り当てません。

## 移行上のリスク

| ID | Gap/Intervention | リスク | 対応 |
| --- | --- | --- | --- |
| RSK-001 | GAP-001/INT-001 | raw表示より処理・表示資源が増える | bounded worker、sanitizer、browser/network spike。元のraw表示は残す |
| RSK-002 | GAP-002/INT-002 | cell-only引用が別の実行結果を指す | immutable run/version IDを使い、未知の引用は解決しない |
| RSK-003 | GAP-003/INT-003 | ヒューリスティックのpassedが科学的保証に見える | 検査対象を明示し、missing evidenceはnot_checked、修復や再実行は行わない |
| RSK-004 | GAP-004〜007/INT-004〜007 | 参照先のprovider、DB、CLI権限、host pathを持ち込む | 後続契約の分割・再承認まで無効。README件数/精度を採用条件にしない |

## 採用しない案

参照アプリのfork、SQLiteへの変更、CLIの広いツール権限、JupyterLabの無保護な外部公開、OpenAI APIの自動追加、文書の自動LLM索引化は採用しません。将来これらの条件が変わる場合は、別の製品判断と設計承認が必要です。
