# AIRA Nexus 設計書

更新日: 2026-11-11

構成と変更設計を説明する。2026-11-11の独立Lab Note変更は、承認済み設計の実装・機能検証と既存環境への移行を完了した。全体の正式資格付けは未完了である。[要件定義書](requirements.md)と [機能別の正式仕様](../.sdd/specs/)を参照し、履歴管理の構成は第9章に記す。唯一の実装計画は既存の [implementation-plan.json](../.sdd/implementation-plan.json)であり、本書は新しい実装計画・承認記録ではない。

## 1. 実行構成と信頼境界

```text
Browser
  -> Dedicated Nginx (explicitly configured trusted LAN only)
  -> Next.js / application writer (127.0.0.1)
       -> PostgreSQL (private Unix socket)
       -> immutable file blobs (private local storage)
       -> saved source versions + transactional Git outbox
       -> owned local bare Git (derived, no external push)
       -> bounded scientific-rendering Worker
       -> Copilot CLI / SDK (explicit outbound confirmation)
       -> owned runtime (explicit execution confirmation)
```

ローカル単独利用ではNginxは不要である。LANモードの `AIRA_PUBLIC_ORIGIN` はアプリと専用プロキシで一致させる。任意の転送ヘッダーから公開元を推測せず、Host・Origin・所有プロジェクトを検証する。現在の構成にアプリのログイン認証やTLSはない。LAN利用者は同じローカル所有者の権限を共有する。

起動・所有資源の終了は [scripts/start.ts](../scripts/start.ts)、プロキシは [scripts/nginx.ts](../scripts/nginx.ts)、APIの合成は [application.ts](../src/server/application.ts) が担う。既存データに対する通常起動で `--initialize` を繰り返さない。

## 2. 画面構成と状態の所有

| 領域                 | 主な責務                                                                           | 保存先・寿命                                                                 |
| -------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 左ペイン             | プロジェクト検索、ピン留め、最近の項目、詳細編集、確認付きアーカイブ、設定         | 名前・説明・ピン・最近開いた時刻はDB。検索語などは画面状態                   |
| 中央固定タブ         | AI Chat、そのすぐ右に実験ノート                                                    | 所有プロジェクト内で常時表示。両方とも閉じる・非表示・並べ替え対象にしない   |
| ノート・ファイルタブ | プロジェクトとノートID／不変ファイルIDで開く・重複防止・並べ替え・閉じる           | ページ内状態。各ノートの下書きを保持し、タブを閉じても研究データを削除しない |
| 右ペイン             | 現在の所有プロジェクトのノートとファイル一覧                                       | プロジェクト単位で取得。仮想ディレクトリは作らない                           |
| 設定                 | テーマ、言語、自己申告の編集者名、手動診断、固定連携カタログ、既存非表示項目の復元 | 外観・表示名はブラウザ。研究データ・連携選択は既存DB契約に従う               |

主コンポーネントは [workspace.tsx](../src/components/workspace.tsx)、[notebook-editor.tsx](../src/components/notebook-editor.tsx)、[files-panel.tsx](../src/components/files-panel.tsx)、[workspace-settings.tsx](../src/components/workspace-settings.tsx)。

[messages.ts](../src/components/messages.ts) の共通辞書を介し、固定タブを日本語「実験ノート」、英語「Lab Note」にする。右のエクスプローラーにある独立ipynb管理は「ipynb」と区別する。個別ipynbタブの保存済み名前、既存ノートの本文・ファイル名は翻訳・改名しない。

プロジェクト単位の状態は固定Chat／Lab Noteと、その後ろのipynb／file viewer列を分けて保持する。並べ替えは動的列だけを操作する。固定Lab Noteと個別ipynbのeditorを通常のタブ切替でunmountせず、dirty／busyをそれぞれ管理する。閉じた世代の遅延callbackは無視し、再度開いた同じipynbへ状態を流用しない。dirtyな個別ipynbのcloseと、Lab Noteを含めたプロジェクト離脱・アーカイブは確認し、取消では全下書きと選択を維持する。busyな変更操作は発生元viewerのcloseとプロジェクト離脱・アーカイブを防ぐが、他viewerの操作は妨げない。create／importと提案適用もプロジェクトのbusy判定へ含める。activeな動的viewerを閉じると隣接動的viewerかAI Chatを選び、inactiveなviewerのcloseでは選択を変えない。Lab Noteの読込中・失敗時も固定タブを残し、明示エラーを表示する。

### 独立したプロジェクトLab Note

#### Text／直接リッチ編集（実装・機能検証済み）

専用ノートに限り、上部の2モードを全Markdownセルへ適用する。Textは保存メタ情報を含む編集可能な原文、Markdownレンダリング表記はスキーマベースのProseMirrorによる直接編集とする。上部の書式／日時操作は最後にフォーカスしたセルと保持中の選択へ適用し、フォーカスがなければ最初のセル、空ノートでの明示日時挿入は新規Markdownセル1つを対象とする。日本語のタブ名は「実験ノート」、英語は「Lab Note」へ統一するが、保存済み名称は書き換えない。

HTMLを新しい保存形式にせず、既存のMarkdown・セルID・保存API・履歴を維持する。厳密な既存YAML検査で原文のprefix/bodyを分離し、リッチ編集は本文だけを変更する。表示・モード切替は再シリアライズせず、実際の編集時のみMarkdownへ戻す。更新後のBOMと既存ヘッダーは明示保存まで原文を保持し、保存時は従来の保存済みメタ情報を基準とする。無効なYAMLは明示エラーとし、Textで修正できる。

数式・表・Mermaid・コード・画像等の編集スキーマ外の内容は原文を保持した非編集プレビューとし、既存の制限付き科学描画・所有ファイルAPIを再利用する。プレビュー内部の修正はTextで行う。任意HTMLの取り込み、直接画像URL、外部アクセス、編集リンクの自動遷移、コード実行を許可しない。paste/dropは制限したplain textだけを受け付ける。アーカイブ／busyではDOM編集とトランザクションの双方を拒否する。

実装は [journal-markdown.ts](../src/lib/journal-markdown.ts) と [journal-markdown-editor.tsx](../src/components/journal-markdown-editor.tsx) に分離し、専用ノートだけをNotebookEditorへ接続する。ProseMirrorのトランザクション・undo履歴を共用し、ソースの通知し返しではviewを再生成しない。モード／言語切替時はセルviewを再生成し、IME中は切替を止める。プレビューはReact portalで既存の外観・言語コンテキストを保つ。リッチ表示はセル全体のUTF-8で64 KiB、複雑プレビュー100個を上限とする。明示的な編集でEOF終端のYAMLへ本文を足す場合だけ、区切り改行を補う。

隔離Chromium spikeに加え、実アプリのTEST-LAYOUT-012で6書式×選択有無の12行、Text／リッチ×アーカイブ／active×busy／idleの8行、セル選択への日時挿入、両モードのundo/redo、日本語composition、保存・再読込、無効YAMLからのText回復、拒否したpasteでの本文保持、外部リクエスト0件を確認した。原文・UTF-8境界・複雑ソースはTEST-MARKDOWN-005/006でも検証する。独立レビューの反例を修正し、11種類の機構変異で実際のassertion Red、原文復元、native Greenを確認した。全148試験に合格したが、既存22タスクのfresh receipt更新と固定matrix連続2回による正式資格付けは別途未完了である。

1プロジェクトにつき1つの専用Markdownノートを持ち、ipynbの管理画面や最初のipynbを代用しない。内部では既存のnbformat本文・Markdown編集・版管理を再利用するが、通常ipynbの一覧・作成・インポートと区別する。Lab Noteにはコードセル・実行UIを設けず、サーバの共通保存経路でもMarkdown以外を拒否する。表示切替、YAML、保存履歴・差分・復元の仕様は既存機構を継承する。

`project_lab_notes` はprojectを主キー、notebook IDを一意とし、ノートとproject／actorの関連を外部キーで束縛する。アプリには関連のSELECTだけを許可する。新規projectの単一chat作成トランザクション内で、migration所有・固定search_pathの関数をtriggerから呼び、空ノート・関連・実際の初期create版・Git出力意図をまとめて作る。PUBLIC／アプリから関数を直接呼び出す権限は与えない。既存projectにも同じ関数で空の専用ノートを追加する移行を用意し、writer静止のtry-lockとトランザクションで原子性・再実行性を保証する。

Migration 014の作成triggerは `AFTER INSERT ON chats DEFERRABLE INITIALLY DEFERRED` の制約triggerとし、既存の遅延外部キーとchat先行／project先行の両挿入順序を維持する。コミット時に専用ノートを確定し、失敗時は関連・初期版・Git出力意図も同じトランザクションでロールバックする。

既存の「Demo Lab Note」等も通常ipynbとして保持し、名前から昇格させない。既存の本文・revision・保存履歴・実行記録・不変ファイルは書き換えない。新規専用ノートの初期版には現在のサーバ時刻と不明／systemの編集者を記録し、過去の人間の編集を捏造しない。

GET `/api/projects/:projectId/lab-note` は所有・可視性を検証して関連ノートを返す読み取り専用APIとし、欠落を暗黙修復しない。本文保存と履歴は既存のノートIDに束縛されたAPIを再利用する。生API・PATCH・提案適用・復元も共通のMarkdown専用検証を通す。アーカイブでは参照のみ許可し、非表示・他project／actorは既存どおり拒否する。内部のGit出力形式は既存のsource-only ipynbのままであり、画面上のipynb一覧へ混入させない。DB＋blobバックアップとcurrent-head検証には専用ノートも含める。

DBにも専用ノートの現在本文・保存版にMarkdown専用の制約triggerを置き、直接のアプリロール更新でもcode／rawセルを拒否する。通常ipynbのコードセルは制限しない。バックアップ・独立復元では関連の一意性、所有scope、全保存版のMarkdown制約とcurrent-headを検査する。現行の復元は空の新スキーマへdata-only pg_restoreを行うため、新しい復元先だけで専用ノートの自動作成triggerを一時停止し、finallyで再有効化してから検査する。外部キーや他の制約を全体無効化せず、復元中に別IDの空ノートを作らない。旧スキーマのバックアップは既存どおり、復元先の作成前にschema hash不一致で明示拒否し、暗黙に昇格・改変しない。

## 3. Markdown表示状態

| 対象                     | 初期状態     | 選択できる状態                    | 保存との関係                                                         |
| ------------------------ | ------------ | --------------------------------- | -------------------------------------------------------------------- |
| チャット                 | 科学描画     | ユーザー向けの科学描画OFF操作なし | 表示で保存本文を書き換えない                                         |
| Markdownファイル         | レンダリング | 原文／レンダリング                | 開いているファイルごとに保持。閉じて開き直すか再読み込みすると初期化 |
| 既存Markdownセル         | レンダリング | 原文／レンダリング／編集          | モード変更だけではdirtyにしない                                      |
| 新規Markdownセル         | 編集         | 原文／レンダリング／編集          | 既存のノート保存操作で確定                                           |
| アーカイブのMarkdownセル | レンダリング | 原文／レンダリング。編集は無効    | 内容変更・実行は不可                                                 |

原文はエスケープ済みの読み取り専用表示、編集はtextareaとする。編集モードの下書きを別モードへ切り替えても破棄しない。既存の未保存確認、タブ移動時の保持、リビジョン検証を再利用し、独立したセル保存APIは追加しない。

[ScientificView](../src/components/scientific-view.tsx) は描画待ち・失敗時に原文へフォールバックし、エラーを明示する。[math-worker.ts](../src/server/math-worker.ts) は上限付きのMarkdown・数式処理とサニタイズを行う。有効なYAML front matterはレンダリング対象から除外するが、保存本文・原文表示・ダウンロード・エクスポートでは保持する。

## 4. YAMLメタ情報の更新処理

[markdown-metadata.ts](../src/lib/markdown-metadata.ts) をGUIアップロードとセル保存で共有する。

```yaml
---
aira:
  created_at: 2026-11-11T00:00:00.000Z
  updated_at: 2026-11-11T00:00:00.000Z
  editor_identity: self-declared
  editor_history:
    - edited_at: 2026-11-11T00:00:00.000Z
      editor: Example Editor
---
```

ノート保存では、読み込んだ保存済みMarkdownを基準とする。追跡済みセルの本文が同一ならソースをそのまま返す。変更があれば保存済みの作成日と編集者履歴を維持し、最終編集日と今回の編集者を追加する。履歴欄を下書きで書き換えても、保存済み履歴を置き換える材料として使わない。ただし、これは真正性を保証する仕組みではない。

GUIのファイルアップロードでは、先頭の制限付き範囲を読み、更新したヘッダーと元ファイルのbodyバイト列から新しいBlobを作る。UTF-8デコーダーは先頭BOMを文字列上で保持し、BOMを本文と分離して管理する。元のヘッダー、ヘッダーがない場合はBOMだけのUTF-8バイト長で元ファイルをsliceし、新しいBOM・管理ヘッダーの後ろへ本文バイト列を接続する。セル保存でも同じBOM配置を維持する。ファイル全体を文字列化せず、UTF-8の境界とbodyのバイト列を維持する。ローカル元ファイルや既存の不変バージョンは変更しない。生APIの転送やSDK・実行生成物へ、編集者名を黙って注入する処理はない。

[appearance.tsx](../src/components/appearance.tsx) はテーマ・言語・編集者名を検証してブラウザに保持する。旧形式のテーマ・言語だけの設定も読み込み、編集者名を `local` として補う。設定保存の失敗や不正値は明示する。YAMLの時刻はブラウザのUTC時刻、編集者は自己申告である。未追跡データの過去の編集者・時刻は推測しない。

## 5. 画像・SVG・Mermaidのデータフロー

### 所有画像

```text
![alt](aira-file:FILE_UUID)
  -> validate project/file UUIDs
  -> /api/projects/PROJECT_UUID/files/FILE_UUID/image
  -> local boundary + owner/project lookup + blob hash verification
  -> validated/re-encoded PNG
```

[file-preview.ts](../src/server/file-preview.ts) と [svg-preview.ts](../src/server/svg-preview.ts) が画像検証を行う。PNG/JPEGは署名・画素・ページ数を検証して再エンコードする。SVGは静的要素・属性だけを許可し、外部参照、スクリプト、HTML、style/event/href属性等を拒否してSharpでPNGへ変換する。

SVGファイルのタブも同じ `/image` を利用する。生SVGを返さない `/preview` の415応答を、SVGタブの通常表示に使わない。`/download` は元バージョンの正確なバイト列をattachmentとして返す。表示用PNGと元SVGの不変保存を混同しない。

### Mermaid

[ScientificHtml](../src/components/scientific-html.tsx) はMermaid fenceがある場合だけ描画ライブラリを読み込み、strict設定と入力制約を適用する。一時的な非表示の計測領域を使い、後始末で除去する。研究本文内には生成SVGを挿入せず、デコードしたBlob-backed画像と元ソースの開閉表示を配置する。不要なBlob URLを解放する。

画像の所有境界、原文保持、描画失敗の明示は、チャット・ノート・ファイルのいずれでも維持する。詳細な容量・画素・時間制限は [要件定義書](requirements.md)の第3章と機能別仕様を参照する。Mermaidのブラウザ側制限はOS隔離や強制中断可能なCPUタイムアウトではない。

## 6. 永続化・更新・実行

PostgreSQLはプロジェクト、チャットの関連、ノート本文JSONB、提案・確認・実行記録を保持する。ファイルは不変ID、所有者、プロジェクト、SHA-256、private blobの関連で管理する。プロジェクトのアーカイブ・非表示・変更は既存の所有検証とwriter fenceに従う。

[notebooks.ts](../src/server/notebooks.ts) の保存は、所有プロジェクトと現在のリビジョンを確認して本文を更新する。古いリビジョンは409で拒否する。コード実行の結果は [provenance](../.sdd/specs/provenance.md) の不変記録へ紐付け、後の本文編集で過去の実行を現在の実行結果と偽らない。表示や復元候補の確認だけでコードを実行しない。

`revision` による楽観ロックと同じトランザクションで本文の版スナップショットとGit出力意図を追記する。YAML履歴、実行履歴、本文の版履歴は別のデータである。

## 7. 診断・運用・安全性

診断は左下の設定の明示操作から `/api/readiness` を呼び出す。設定を開いた時の自動診断は行わず、処理中の重複実行・閉じる操作を抑止し、過去の成功表示を失敗時に残さない。資格情報・研究本文を診断ログへ含めない。

バックアップは既存のDBと参照blobの整合した組を扱い、復元先は独立した空の領域とする。原本への上書き、過去のコンテナに対する権限の継承、実行の自動再開を行わない。

自己申告名、Gitのauthor欄、YAML日時はログイン認証や信頼できる時刻証明を代替しない。現在のLAN構成は利用者間の本人性や分離を保証しない。

## 8. 検証との対応

| 設計箇所                                                   | 主な既存試験                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| 固定Chat／Lab Note、個別ipynb viewer、日英名称、下書き保持 | TEST-LAYOUT-002、TEST-LAYOUT-003、TEST-LAYOUT-005、TEST-LAYOUT-011         |
| 専用ノートの一意性、原子的作成、Markdown制約、非破壊移行   | TEST-NOTE-004、TEST-NOTE-005、TEST-SESSION-001                             |
| 専用ノートの関連・全保存版を含むバックアップと独立復元     | TEST-NOTE-006                                                              |
| SVG直接表示、画像埋め込み、Mermaid                         | TEST-DATA-004、TEST-RENDER-004、TEST-LAYOUT-007                            |
| Markdownファイルの原文／レンダリング                       | TEST-LAYOUT-008                                                            |
| セルの3モード、自己申告名、保存・読み取り専用              | TEST-LAYOUT-009                                                            |
| YAML履歴・UTF-8・BOM保持・不正ヘッダー                     | TEST-MARKDOWN-001、TEST-MARKDOWN-002、TEST-MARKDOWN-003、TEST-MARKDOWN-004 |
| メタ情報を除いた安全な本文描画                             | TEST-RENDER-005と既存TEST-RENDER群                                         |
| 実行・送信確認、ノート・ファイルの既存操作                 | [workspace E2E](../test/e2e/workspace.spec.ts)                             |
| 原子的な保存履歴、移行、差分、復元、再試行、停止、独立復元 | TEST-NH-001〜004、TEST-NH-006とその停止・再起動ケース                      |
| Gitの所有境界、決定的出力、初期化復旧、CAS、破損拒否       | TEST-NH-005                                                                |
| 履歴画面、日英表示、確認・取消、下書き・アーカイブ保護     | TEST-NH-007                                                                |

履歴管理の初回機能検証ではDB・Git試験45件、関連ブラウザ試験5件、既存E2E、型チェック・lint・ビルドが合格した。DB/復元とGitのリスク別実装レビューの指摘も修正済みである。追加のBOM修正は実際のRed／Green、メタ情報試験10件、4種類の隔離変異で確認した。正式な全体資格付けは、既存設定を弱めず全22タスクの最新receiptと固定行列の連続2回の全体検証によって判定する。実装後の反例再検証と当初のTDD履歴を区別し、機能試験や配信成功で既存承認を更新したとはみなさない。

独立Lab Note変更後の全145試験は、既存600秒予算内の約522秒で145件合格、失敗・skipなし。既存E2E 1件、diagnostics、書式検査も合格した。15種類の隔離変異でassertion Red、正確なソース復元、native Greenを確認し、固定差分の独立レビューでも未解決S1/S2は残っていない。既存環境ではschema 014と固定タブを確認し、Demoの既存ノート本文・revision 1・実行記録0件・不変ファイル6件のハッシュを保持した。ただし、これらは全22タスクの正式receipt更新と固定行列の連続2回検証の代用ではない。

## 9. 電子実験ノートの版管理

### 正本と変更経路

**PostgreSQLの版スナップショットと追記型変更記録が正本、ローカルGitは派生表現**である。[notebook-versions.ts](../src/server/notebook-versions.ts) と [013-notebook-history.sql](../src/server/migrations/013-notebook-history.sql) が保存履歴・出力状態を扱う。全保存版を保持し、外部push・自動削除・履歴独自の容量上限は設けない。承認済み契約は [notebook-history](../.sdd/specs/notebook-history.md) を参照する。

作成・インポート・保存・PATCH・AI提案の適用・復元は、既存の単一writerの直列化トランザクションでノート更新、版追加、出力意図追加を確定する。版IDはその中で採番し、ロールバック時の欠番は許容する。アプリロールには保存版のSELECT/INSERTだけを与え、UPDATE/DELETEを許可しない。

移行はwriterのadvisory try-lockを同じトランザクションで取得する。既存ノートの本文・名前・リビジョン・関連・実行記録を変えず、現在版だけをベースライン登録する。既存不変ファイルを書き換えず、過去の日時・編集者を推測しない。

保存内容の `{name, document}` はPostgreSQLの `jsonb::text` をUTF-8化したSHA-256で識別し、復元・出力前に検証する。保存版のnative code出力は空、execution countはnullにし、元の実行証拠は既存記録へ残す。

外部ファイルとして登録した画像・大きな実行出力は既存の不変blob／実行記録を参照し、各版へ新しい実行結果としてコピーしない。ipynb内の添付データは本文の一部として保持し、版ごとの容量を消費する場合がある。Gitでipynbを比較するなら [nbdime](https://nbdime.readthedocs.io/en/latest/) が構造的な差分表示・マージの候補になるが、nbdime自体は履歴保存基盤ではない。

### 履歴APIと画面

既存の `/history` は実行履歴のままとし、保存版は `/api/projects/:projectId/notebooks/:notebookId/versions` へ分離する。最大50件のkeyset一覧、版詳細、`/:revision/diff?against=OTHER_REVISION`、`/:revision/restore`、`/git/retry`、`/git/rebuild` を提供する。全経路で所有者・プロジェクト・ノートを検証し、非表示・他の所有者の対象は404とする。アーカイブでは本文を復元できないが、参照と派生Gitの再試行・再構築は許可する。

[notebook-history.tsx](../src/components/notebook-history.tsx) は既存ノート内の「保存履歴／Saved history」ダイアログであり、新しい固定タブは追加しない。過去版は実行不能な原文として表示し、ソース・メタ情報の各表示を64 KiBに制限して省略を示す。詳細・差分APIの12 MiB超過は明示的に拒否し、完全なDB保存版は残す。差分はセルIDで追加・削除・順序・ソース・種別・メタ情報・添付を比較し、ノート名も比較する。

復元確認は選択版と表示時の現在リビジョンに束縛する。サーバが再検証して当時の本文・YAML・名前を新規版へ戻し、復元元・記録時刻・自己申告実施者を別イベントへ残す。下書き・アーカイブ時は画面でも復元不可とし、取消・参照だけでは保存・実行・外部送信しない。

### Git出力・復旧・バックアップ

[notebook-git.ts](../src/server/notebook-git.ts) は固定UUIDパスのprivate bareリポジトリへ `.ipynb` と版記述子を出力する。所有マーカー、世代、UID、権限、シンボリックリンクと排他的nonceロックを検査する。シェル・外部push・フック・フィルタ・署名プロンプト・継承Git設定を利用しない。

DB確定後のworkerがプロジェクト内の順序を維持し、準備済みparent/tree/commitを永続化してから期待HEADに対するCASを行う。ref更新後・DB確認前の中断は、完全一致する予定コミットだけを重複なく確認する。通常の連続出力はinodeと直前HEADに束縛した検査結果を再利用し、新しい内容を検証する。再起動・中断復旧・不一致では完全検査する。

既知の初期化失敗では、所有と空の初期状態を証明できる場合だけ再試行する。後始末で削除できるのは、その呼出しが作成しinode・nonce・内容を照合できる一時資源だけであり、既存の未管理リポジトリや不明ロックを採用・削除しない。

自動試行は最大3回で停止し、画面へ状態と固定エラーコードを示す。再試行・新世代再構築はノート単位でなくプロジェクト全体を対象とし、再構築確認を表示世代に束縛する。旧リポジトリは残す。ハードクラッシュの不明ロックや不整合には明示的な新世代再構築が必要で、処理上限を超える内容は再構築後も黙って飛ばさない。

起動時はwriter取得後にworkerを開始し、終了・lease喪失時は新規出力を止め、所有childの終了を待つ。DBとGitの物理的な同時確定は保証しない。

DB＋blobのバックアップは保存版を含み、派生Gitディレクトリは含めない。独立復元は全版ハッシュと各ノートの現在版の一致を検証し、コピーしたGit出力状態をリセットする。新しい所有世代でGitを再構築し、DB版ID・ハッシュを保持するが、Git SHAの一致や過去のプロセス・パスの権限を引き継がない。

DBの追記制約やハッシュを追加しても、管理者による書換えまで単独で防げるとはみなさない。Gitの署名も、利用者認証・時刻証明・規制要件を単独で満たすものではない。認証や電子署名の追加は今回の範囲に含めない。

参考: [PostgreSQL Trigger Functions](https://www.postgresql.org/docs/current/plpgsql-trigger.html)、[Git commit](https://git-scm.com/docs/git-commit)、[nbdime](https://nbdime.readthedocs.io/en/latest/)。
