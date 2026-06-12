# 外部ツール移行インポート — APIコネクタ設計ノート

> 対象: ADR-0034「外部PMツールからの初回データ移行インポート」第1弾5サービスのAPI知見。
> 作成: 2026-06-04 / すべて各サービスの**公式ドキュメント**で実在確認済 (URLは各節)。推測値は「要確認」と明記。
> 位置づけ: コネクタ実装・テスト実装の一次入力。たすきば側の取り込み仕様は ADR-0034 と `docs/design/COLUMN_USAGE_MAP.md` / `docs/public/field-reference.md` を正本とする。
>
> **提供状況 (2026-06-05 更新):**
> - **手動CSV経路は提供済 (v1.1.0)**: `/settings/tenant/migration-import` の 4 ステップウィザード (顧客・プロジェクト・WBS・リスク・課題・ナレッジ・振り返りの 7 種類、テンプレCSV + 列マッピング + プレビュー → 取込)。実装は `src/services/import/` (csv-to-batch / batch-preview / batch-apply / migration-import.service)。
> - **API 連携 (Notion / Backlog / kintone / Pleasanter / Google Sheets) は ベータ 提供 (2026-06-05 実装)**: コネクタは `src/services/import/connectors/` に実装 (`http.ts` 共通基盤 + `notion/backlog/kintone/pleasanter/google-sheets.ts` + `types.ts` / `registry.ts` / `wbs-rows.ts`)。各コネクタは「fetch → `CsvEntitySource[]` 正規化」までを担い、検証・値解決・WBS階層・依存解決・取り込みは手動CSV経路の `buildBatchFromCsv` → `previewMigration` → `applyImportBatch` を**そのまま再利用** (batch-preview / batch-apply は無改変)。ルート: `connect/discover`・`connect/preview` (確定は既存 `/migration-import/apply`)、UI: `/settings/tenant/api-import`。認証情報は取得処理の間だけ使用し永続保存しない (毎回入力)。各サービスは HTTP 境界をモックした単体テストで担保。

---

## 0. 共通設計

### 0-1. コネクタの責務 = 「相手のデータを共通中間形式に正規化する」だけ

各サービス固有処理はコネクタに閉じ込め、出力を**共通中間形式 (NormalizedBatch)** に揃える。マッピング・検証・依存解決・取り込みは既存 `external-data-import` / `task-sync-import` の基盤を流用する (ADR-0034)。

```
NormalizedBatch {
  customers:  [{ sourceKey, name, ...fields }]
  projects:   [{ sourceKey, customerRef?, name, ...fields,
                 wbs:   [{ level, name, plannedStartDate?, plannedEndDate?, plannedEffort? }]  // 前順序+深さ
                 risks: [...], knowledge: [...], retros: [...] }]
}
```

- **WBSは「前順序 (親が子より先) + レベル (深さ)」**に正規化 → 既存の親スタックロジック ([task-sync-import.service.ts](../../src/services/task-sync-import.service.ts)) にそのまま流す。
- **WP/ACT判定は構造ベース** (子を持つ=WP / 葉=ACT)。ソースの「種別」は使わない (ADR-0034)。

### 0-2. 共通認証モデル (取得後即破棄)

全サービスで**read専用のトークン/キー方式**が成立する。認証情報は取得の数秒だけメモリ保持し、取得直後に破棄 (永続保存しない)。確定 (apply) は保存済みプレビューから行うため認証情報を要しない (ADR-0034 §9)。

| サービス | 第一導線 | 認証情報の渡し方 |
|---|---|---|
| Notion | Internal Integration Token (capability=Read content) | `Authorization: Bearer` + `Notion-Version` ヘッダ |
| Backlog | API キー (個人設定で発行) | クエリ `?apiKey=` + ベースURL (`.com`/`.jp`) |
| kintone | API トークン (アプリ単位・閲覧のみ) | `X-Cybozu-API-Token` ヘッダ + サブドメイン |
| Pleasanter | ApiKey (ユーザ単位) | JSON ボディ `"ApiKey"` + `"ApiVersion":1.1` + ベースURL |
| Google Sheets | OAuth `spreadsheets.readonly` (公開シートはAPIキー可) | `Authorization: Bearer` or `?key=` |

ベースURL/サブドメインは**ユーザ入力**にする (推測禁止)。

### 0-3. 共通テスト戦略

- **HTTP層を境界にモック**。実APIは叩かず、各エンドポイントの**最小レスポンスJSONをフィクスチャ化** (下記各節に骨格)。SDK非依存の素RESTレスポンスで保持し将来の差し替えに強くする。
- フィクスチャ単位 = エンドポイント × シナリオ (正常1ページ / 複数ページ境界 / 末尾<上限 / 異常系429・404・権限不足)。
- 純関数を分離: 「型→値の抽出器」「親子グラフ→前順序+レベル変換」「ページングループ」を副作用境界 (fetch) から切り離し決定的にテスト。
- たすきば既存ルール: 取り込み先 `viewerTenantId` を必須付与 (越境防止)、新規 route/page は `docs/test/E2E_COVERAGE.md` 追記 + `pnpm e2e:coverage-check`。

---

## 1. Notion

公式: developers.notion.com / **Notion-Version: `2026-03-11`** / ベース `https://api.notion.com`

### 認証
- **Internal Integration Token + capability「Read content」**で最小構成。`Authorization: Bearer <token>` + `Notion-Version` ヘッダ。
- ユーザは移行対象のページ/DBを**手動でインテグレーションに共有**する必要あり (共有漏れは移行前チェックで検出)。
- 担当者(people)の氏名/emailは capability「User information (with email)」が無いと `id` のみになり得る (要確認)。
- 出典: [authorization](https://developers.notion.com/docs/authorization) / [capabilities](https://developers.notion.com/reference/capabilities)

### ★最重要: データベース/データソース分離 (2025-09-03〜)
- **`POST /v1/databases/{id}/query` は廃止 → `POST /v1/data_sources/{data_source_id}/query`**。
- フロー: ① `POST /v1/search` か既知ID → ② `GET /v1/databases/{id}` の `data_sources[]` から `data_source_id` 解決 → ③ data source を query。
- 出典: [upgrade-guide-2025-09-03](https://developers.notion.com/docs/upgrade-guide-2025-09-03) / [query-a-data-source](https://developers.notion.com/reference/query-a-data-source)

### 主要エンドポイント
| 目的 | メソッド/パス |
|---|---|
| DB/ページ列挙 | `POST /v1/search` (filter: object=page/data_source) |
| DB取得(ds解決) | `GET /v1/databases/{id}` → `data_sources[]` |
| スキーマ取得 | `GET /v1/data_sources/{ds_id}` (`properties`) |
| 行取得 | `POST /v1/data_sources/{ds_id}/query` |
| ページ本文 | `GET /v1/blocks/{page_id}/children` (第1階層のみ→再帰) |

### 階層
- **Sub-items = 同一データソース内の dual_property relation**。relationプロパティを辿って親子グラフを構築 → 前順序+レベルに変換。
- relation/peopleは **25件で truncate** (`has_more:true`)、超過はプロパティ取得で補完 (要確認)。
- 関連先DBが未共有だと relation が空で返る。

### ページング / レート制限
- `start_cursor`/`has_more`/`next_cursor`、`page_size` 最大100 (常に100指定推奨)。
- **平均3 req/s/コネクション**。超過は **429 + `Retry-After`(秒)**。逐次+バックオフを最初から実装。
- 出典: [request-limits](https://developers.notion.com/reference/request-limits)

### プロパティ抽出 (各値は `{id,type,<type>:値}`)
title/rich_text→`plain_text`結合 / number→数値 / select・status→`name` / multi_select→`name[]` / date→`{start,end}` / people→`id`(name/email は capability次第) / relation→`{relation:[{id}],has_more}`

### フィクスチャ骨格
- `retrieve-database` (`data_sources[]` 含む) — ID解決パス
- `data-source-query` (`has_more:false` 版 / `true`+`next_cursor` 版) — ページング
- `page` (プロジェクト/タスク/リスク/ナレッジ別) — 抽出器単体
- sub-item relation入りページ群 — WP→ACT復元
- `blocks-children` — 本文テキスト化
- 異常系: 429+Retry-After / 404(未共有) / relation has_more / people id-only

### マッピング案
Notionは自由構造 → **ユーザがDB→エンティティ、プロパティ→項目を指定**する前提。タスクDB1本+sub-item relationでWP/ACT階層。ナレッジ本文は blocks children を再帰取得しテキスト化。

---

## 2. Backlog (Nulab)

公式: developer.nulab.com/docs/backlog / API v2

### 認証
- **API キー方式** (`?apiKey=` クエリ) が one-time read の最小構成。OAuth2は過剰。
- ベースURLは `.com`(グローバル)/`.jp`(日本)の2系統 → **フルURLをユーザ入力** (推測禁止)。
- 出典: [auth](https://developer.nulab.com/docs/backlog/auth/)

### 主要エンドポイント
| 目的 | パス |
|---|---|
| プロジェクト一覧 | `GET /api/v2/projects` (`subtaskingEnabled` で親子有効判定) |
| 課題一覧 | `GET /api/v2/issues` (`projectId[]`,`parentChild`,`count`≤100,`offset`) |
| 課題件数 | `GET /api/v2/issues/count` → `{count}` |
| 種別/状態/分類/版 | `GET /api/v2/projects/:id/{issueTypes,statuses,categories,versions}` |

`parentChild`: 0=All / 1=Exclude Child / 2=Child / 4=Parent。

### 階層
- 各課題が `parentIssueId` を持つ (子のみ親IDを保持、単方向)。
- **実質2階層まで** (Backlogサブタスクは1段、孫課題なし)。`subtaskingEnabled=false` は全フラット。
- 多階層WBSは不可 → Backlog親子をそのまま2階層に落とす。

### ページング / レート制限
- `count=100` 固定 + `offset` インクリメント、Countで総数取得。
- 4種別計測 (Read/Update/**Search**/Icon)。**課題一覧・CountはSearch枠 (≈150/分、Readより厳しい)**。
- 超過は **429** + `X-RateLimit-Limit/Remaining/Reset(Unix)`。**`GET /api/v2/rateLimit` で実値を取得**しハードコードしない。
- 出典: [rate-limit](https://developer.nulab.com/docs/backlog/rate-limit/) / [get-issue-list](https://developer.nulab.com/docs/backlog/api/2/get-issue-list/)

### 課題フィールド → たすきば
summary→タスク名 / description→説明 / issueType→**WBS/課題の出し分け** / startDate・dueDate(`yyyy-MM-dd`)→予定日 / estimatedHours→予定工数 / assignee.mailAddress→担当者(メール突合) / status→状態(写像表) / parentIssueId→階層 / milestone→上位フェーズ。

issueType/status/category/milestone の**IDはプロジェクト固有** → 先に参照リストを取りID→名称表を作る。

### フィクスチャ骨格
`projects.json`(subtaskingEnabled true/false) / `issues.page1`+`page2`(100境界) / `issue.detail`(全充足+null混在) / `issues.parent-child` / `issueTypes`/`statuses`/`categories`/`versions` / `count` / `rateLimit`(429+Reset)。

### マッピング案
Backlogプロジェクト→たすきばプロジェクト。issueType=タスク系→WBS(階層)、バグ/課題系→リスク・課題 (**どのissueTypeをどちらにするかはユーザ指定**)。

---

## 3. kintone (サイボウズ)

公式: kintone.dev / ベース `https://{subdomain}.kintone.com`

### 認証
- **API トークン (アプリ単位・閲覧のみ)** が最小構成。`X-Cybozu-API-Token` ヘッダ。
- アプリ単位・最大20トークン・発行後「アプリ更新」必須。**横断参照アプリは複数トークンをカンマ連結**。
- 出典: [authentication](https://kintone.dev/en/docs/common/authentication/) / [api-tokens](https://kintone.dev/en/tutorials/introduction-to-kintone-customizations/api-tokens/)

### 主要エンドポイント
| 目的 | パス |
|---|---|
| レコード一括 | `GET /k/v1/records.json` (offset上限**10,000**) |
| カーソル追加 | `POST /k/v1/records/cursor.json` (`size`≤500) → `{id,totalCount}` |
| カーソル取得 | `GET /k/v1/records/cursor.json?id=` → `{records,next}` (`next:false`で自動消滅) |
| フィールド定義 | `GET /k/v1/app/form/fields.json` (型・label・options) |

**全件取得はカーソルAPIを既定** (offset上限10,000で大規模アプリが取得不能になるため)。

### 階層 (基本フラット)
- 親子は LOOKUP / 関連レコード一覧で表現。**関連レコード一覧 (REFERENCE_TABLE) はGETで値が返らない**。LOOKUPはコピー元の型で値が入るだけ。
- 現実案: **初期実装は全タスクを「ルート直下のACT」としてフラット取り込み**。親子を作る場合のみ、参照値=親キーで突合 (両アプリのトークン要)。SUBTABLEはレコード内配列として取得可。

### ページング / レート制限
- カーソル: 1ドメイン同時10個・10分失効・同時リクエスト不可 → **アプリ逐次処理**。
- **1アプリ1日10,000 req** (9:00 JSTリセット)、**同時100/domain・超過429**。`size=500`でリクエスト削減、429は指数バックオフ自前実装 (公式リトライ数値なし)。
- 出典: [create-cursor](https://kintone.dev/en/docs/kintone/rest-api/records/create-cursor/) / [how-to-avoid-limits](https://kintone.dev/en/tutorials/development-productivity/how-to-avoid-kintone-rest-api-limits/)

### フィールド型 (`{code:{type,value}}`)
SINGLE/MULTI_LINE_TEXT→string / NUMBER・DATE→**文字列** / DROP_DOWN・RADIO→string / CHECK_BOX・MULTI_SELECT→string[] / USER_SELECT等→`[{code,name}]` / CREATOR等→`{code,name}` / SUBTABLE→`[{id,value}]` / REFERENCE_TABLE→**取得不可(除外)**。

### フィクスチャ骨格
`form/fields`(全代表型) / cursor add(`{id,totalCount}`) / cursor get((a)next:true複数(b)next:false(c)404失効) / 異常系(429/401/403)。

### マッピング案
アプリ自由構造 → **ユーザがアプリID+フィールドを指定**、`form/fields.json`の型付き一覧をマッピングUIソースに。案件アプリ→プロジェクト、タスク→フラットACT(既定)、課題アプリ→リスク・課題。RECORD_NUMBERをソースキー保持。

---

## 4. Pleasanter (インプリム)

公式: pleasanter.org/manual / **ApiVersion 1.1** / オンプレ・セルフホストOSSが基本

### 認証
- **ApiKey (ユーザ単位)** を**JSONボディ**に `"ApiKey"` で渡す (ヘッダでない)。`"ApiVersion":1.1` 併記。
- read限定は**ApiKeyでなくユーザ権限**で担保 (移行専用ユーザ+閲覧権限)。
- ベースURL差: オンプレ `{base}/api/...` vs クラウド `https://pleasanter.net/fs/api/...` (`/fs`プレフィックス) → **ユーザ入力で吸収**。
- 出典: [api-key](https://pleasanter.org/en/manual/api-key) / [api-record-get](https://pleasanter.org/en/manual/api-record-get)

### 主要エンドポイント (全て POST/JSON)
| 目的 | パス |
|---|---|
| 複数レコード取得 | `{base}/api/items/{siteId}/get` → `{StatusCode,Response:{Offset,PageSize,TotalCount,Data[]}}` |
| サイト情報 | `{base}/api/items/{siteId}/getsite` (`ReferenceType`,`EditorColumnHash`) |

### テーブル種別 (ReferenceType)
- **`Issues` (期限付き)**: StartTime/CompletionTime/WorkValue/ProgressRate/RemainingWorkValue を持つ → **WBS/タスクのメインソース**。ID=`IssueId`。
- **`Results` (記録)**: 期日系なし → 課題・記録。ID=`ResultId`。
- ※「Pertype/期間」「案内」という種別名は公式で確認できず (種別軸はIssues/Resultsが正)。

### 階層
- 親子は**ユーザ定義の分類項目 (ClassA..Z)** に親レコードIDを保持 (自己リンクで同一テーブル階層も可)。
- **どのClassXが親IDかは固定でない** → **ユーザに「親を指すリンク項目」を指定させる**。

### ページング / レート制限
- **PageSize既定/最大=200**、`Offset`を200ずつ加算、停止 `(Offset+PageSize)>=TotalCount`。安定ソート (ID昇順) 固定推奨。
- オンプレはレート制限の公式記載なし。クラウド版に日次上限の可能性 (要確認) → クライアント側スロットリング+チェックポイント再開を実装。
- 出典: [428033](https://pleasanter.org/manual/428033) / [faq-api-paging](https://pleasanter.org/en/manual/faq-api-paging)

### 項目型
標準: Title/Body/Status(int)/Owner・Manager(userId int)/StartTime/CompletionTime/WorkValue/ProgressRate。ユーザ定義: `ClassHash`/`NumHash`/`DateHash`/`CheckHash`/`DescriptionHash`/`AttachmentsHash`。Status/Owner/Managerは**数値** → 表示名は `ApiColumnValueDisplayType` か user取得APIで解決。

### フィクスチャ骨格
Issues単一/複数ページ(TotalCount境界) / Results / 自己リンク親子(ClassAに親ID) / getsite / Hash各型 / 異常系(StatusCode!=200・ApiKey不正・ページング中TotalCount変動)。

### マッピング案
カラム自由 → **getsiteでReferenceType+EditorColumnHash取得しユーザにマッピング指定**。Issues→WBS、Results→課題。親リンクClassXをユーザ指定。

---

## 5. Google スプレッドシート / Excel

### 結論: 既存CSV基盤 (ヘッダ行→列マッピング + レベル列方式) に寄せる
Sheets の `values` (2次元配列・行×列の文字列) は**CSVパース結果と同型** → 既存CSV取込パイプラインをほぼそのまま再利用。1シート(タブ)=1エンティティ、`values[0]`=ヘッダ、`values[1..]`=データ、WBSはレベル列。

### Google Sheets API v4
- 認証: 最小権限 **`spreadsheets.readonly`** (公開シートはAPIキー可)。トークン非永続化 (移行後失効)。
- 取得: `GET /v4/spreadsheets/{id}/values/{range}` (A1記法、`majorDimension=ROWS`)、複数範囲は `values:batchGet`、タブ列挙は `spreadsheets.get`。
- ページングなし (range一括)。セル上限 **1000万セル**。
- レート制限: **read 60/分/ユーザ・300/分/project**、超過429+指数バックオフ、1リクエスト180秒。
- **空セルは省略され行長が不揃い** → ヘッダ列数に右パディングしてからCSVバリデータへ。
- `FORMATTED_VALUE` 既定で日付/金額も表示文字列 → CSVと同じ正規化を共用。
- 出典: [values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get) / [limits](https://developers.google.com/workspace/sheets/api/limits) / [Drive cell limit](https://support.google.com/drive/answer/37603)
- フィクスチャ: 公式 [Basic reading](https://developers.google.com/workspace/sheets/api/samples/reading) の `values` レスポンスをそのまま使用。

### Excel (.xlsx)
- **SheetJS(`xlsx`)不採用は妥当**: CVE-2023-30533 (Prototype Pollution, High) / CVE-2024-22363 (ReDoS, High)。修正版はnpm未公開 (cdn配布のみ) → npm版は常時High2件。
- **最も安全・低コスト: ユーザにExcel→CSV(UTF-8)エクスポートを依頼し既存CSV経路を再利用** (サーバ側で.xlsxをパースしない=攻撃面ゼロ)。Excelの「CSV UTF-8(コンマ区切り)」を明示指定するようガイド、BOM付きUTF-8も吸収。
- サーバ側.xlsxパースが必要になった場合のみ **exceljs** (現行4.4.0で既知未修正脆弱性なし。ただしメンテ非活発=供給網監視)。
- 出典: [GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6) / [GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9) / [exceljs advisories](https://github.com/exceljs/exceljs/security/advisories)

---

## 6. サービス横断サマリ

| 観点 | Notion | Backlog | kintone | Pleasanter | Sheets/Excel |
|---|---|---|---|---|---|
| read認証 | Integration Token | APIキー | APIトークン | ApiKey(body) | OAuth readonly/APIキー |
| 階層 | sub-item relation | parentIssueId(2階層) | フラット(既定) | ClassX自己リンク(ユーザ指定) | レベル列 |
| 全件取得 | cursor (page_size100) | offset (count100) | **cursor必須** | offset (200) | range一括 |
| レート制限 | 3 req/s | Search≈150/分 | 10000/日・100同時 | 不明瞭(要確認) | 60/分/user |
| 主なレート対策 | Retry-After順守 | rateLimit API実値取得 | size500+逐次 | スロットリング+再開 | 指数バックオフ |
| マッピング | 全項目ユーザ指定 | issueTypeで出し分け | アプリ/項目ユーザ指定 | 全項目ユーザ指定 | ヘッダ→列(CSV同) |

## 6.5. 2026-06-05 公式再検証での修正・確定 (実装時反映済)

実装着手前に各サービス公式で再検証した結果、§1〜§5 から以下を修正・確定した。

- **Backlog**: ベースURL は **3 系統** (`.com` / `.jp` / **`.backlogtool.com`**)。レート実数値は read=600 / update=150 / **search=150** / icon=60 (件/分、`GET /api/v2/rateLimit` で実取得)。**サブタスク (親子) は有料プラン限定** — `subtaskingEnabled=false` のスペースは全課題フラット (discover で警告表示)。
- **Notion**: 行取得クエリのメソッドは **POST** (`POST /v1/data_sources/{ds}/query`。アップグレードガイドの一部 PATCH 表記は誤り)。people の email は capability「User information (with email)」必須。relation は 25 件で truncate。Notion-Version=`2026-03-11` 固定。
- **Pleasanter**: 表示名解決は View に **`"ApiDataType":"KeyValues"`** 指定が必須 (未指定だと Status/Owner/Manager が数値ID)。`Wikis` 種別は移行対象外として除外。
- **Google Sheets**: 1 セル上限は 5 万字 (Sheets 側)。Excel→CSV 経路はこの上限を迂回するため、**取り込み側で DB カラム長 (VarChar) を検証**しサイレント切り捨てを禁止 (`import-field-catalog.ts` の `IMPORT_FIELD_MAX_LENGTH` + `csv-to-batch` で実装)。
- **kintone / Pleasanter のレート上限**: 公式に明記なしの項目は引き続き「要確認」。共通 HTTP 基盤 (`connectors/http.ts`) が 429 + `Retry-After` / `X-RateLimit-Reset` 順守 + 指数バックオフで吸収する。

## 7. 要確認事項 (実装着手前に各公式で再確認)

- Notion: ページングデフォルト件数 / people の email 取得条件 / relation 25件超の補完エンドポイント / 旧 `databases/query` の現行挙動。
- Backlog: レート制限の per-plan 実数値 / 状態の完全な既定IDセット / スペースTLDのバリエーション。
- kintone: Liteプランの日次上限表示 / 429リトライ推奨間隔 / 添付(FILE)移行をスコープに含めるか。
- Pleasanter: クラウド版の日次API上限 / ApiKeyのreadスコープ有無 (権限はユーザ側制御の想定)。
- Sheets: 「公開データはAPIキー可」の公式verbatim / レスポンスバイト上限。

## 8. 関連

- [ADR-0034](../adr/0034-external-tool-migration-import.md) — 本機能の決定
- [docs/design/COLUMN_USAGE_MAP.md](./COLUMN_USAGE_MAP.md) / [docs/public/field-reference.md](../public/field-reference.md) — 取り込み対象項目の正本
- 取込基盤: [import/migration-import.service.ts](../../src/services/import/migration-import.service.ts)（preview→apply の 2 段階・`tenantImportPreview` TTL は [import/tenant-import-preview.service.ts](../../src/services/import/tenant-import-preview.service.ts) が GC）/ 流用元: [task-sync-import.service.ts](../../src/services/task-sync-import.service.ts)
  - ※ 旧 `external-data-import.service.ts`（ナレッジ・課題専用の 2 段階フロー）は本機能 (ADR-0034) へ統合し撤去済み。
