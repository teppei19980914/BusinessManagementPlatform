# 既存機能を修正するとき (Modify Feature Guide)

本書は **既存機能の改修** に着手する開発者向けの手順書です。新規画面・新規機能の追加は [HOW_TO_ADD_FEATURES.md](./HOW_TO_ADD_FEATURES.md)、削除は同書 §6 を参照してください。本書は「すでにあるものを直す」ときの調査・流用・横展開・退行防止に特化します。

> **本プロジェクトの最優先方針**: 既存実装を徹底的に流用する。新規設計に走るのは「(a) 流用できる既存実装が存在しない」かつ「(b) 流用にリスクがある」の **両方** を満たすときだけです。

---

## 0. 着手前に: 影響範囲を確定する

修正は「直す対象」より「直すと壊れる範囲」の特定が先です。コードを書く前に必ず影響範囲を grep で洗い出します。

### 0.1 grep の 4 軸 (必須)

値・文言・識別子を変更するときは、以下の **4 軸すべて** で検索します。1 軸だけだと取りこぼします (価格定数 ¥1→¥5 改定で実証済の盲点)。

| 軸 | 何を探すか | 例 |
|---|---|---|
| **生値** | コード内のリテラル・定数 | `5` / `EMBEDDING_UNIT_PRICE_JPY` |
| **表示文字列** | UI に出る整形済み文字列 (`toLocaleString` 等) | `'1,500'` / `¥5` / `50GB` |
| **自然文** | 説明文・ツールチップ・docs・ADR・コメント中の記述 | `月 50 回まで無料` / `200M tokens` |
| **テストアサーション** | 単体テスト / Playwright spec の期待値 | `toContainText('¥5')` / `expect(...).toBe(5)` |

> コメント・docs・ADR で宣言した値は **実装証跡を grep で必ず確認** すること。「コメントには `> 500` 制限と書いてあるが実装は 0 route で未実装」のような乖離が過去に発生しています。3 巡目検証では「コメント vs 実装の乖離 grep」を必ず含めます。

### 0.2 関連レイヤの洗い出し

1 機能は通常、複数レイヤにまたがります。修正対象の機能について以下を列挙してから着手します。

- **config 定数**: `src/config/*` の該当ファイル ([HOW_TO_ADD_FEATURES.md §1](./HOW_TO_ADD_FEATURES.md) のファイル一覧参照)
- **service**: `src/services/*.service.ts` (ビジネスロジック本体)
- **route**: `src/app/api/**/route.ts` (HTTP 層・認可・検証)
- **UI**: `src/app/(dashboard)/**/page.tsx` (サーバ) + `*-client.tsx` (クライアント)
- **i18n**: `src/i18n/messages/ja.json` + `messages.test.ts` の必須キー
- **validator**: `src/lib/validators/*.ts` の Zod スキーマ
- **テスト**: 各レイヤの `*.test.ts` + `e2e/` の spec

---

## 1. 既存実装の流用を最優先する

修正方針を決めるとき、まず「同じことをしている既存実装があるか」を探します。

- 同型の service 関数・helper・UI コンポーネントがあればそれに合わせる (独自実装で分岐を増やさない)
- 閾値・上限・単価などの業務的意味を持つ値は **必ず `src/config/` に集約** されている前提で探す (ゼロハードコーディング原則)
- 既存の docblock (ファイル先頭) に「設計判断 / 認可 / 関連設計書」が書かれているので、改修方針はそれと矛盾しないようにする

新規パターンを導入する前に、上記 (a)(b) の両立条件を満たすかを自問してください。

---

## 2. レイヤ別の修正ポイント

標準リクエストライフサイクル (画面 → route → service → DB → 監査 → 非同期) は [design/KEY_FLOWS.md §1](../../design/KEY_FLOWS.md) が連結資料です。改修時はこの経路のどこに手を入れるかを意識します。

### 2.1 config 定数の変更

- 多くの業務値は `src/config/*` の 1 行編集で全体に反映されます ([HOW_TO_ADD_FEATURES.md §1.2](./HOW_TO_ADD_FEATURES.md))。
- **課金分類 (`BILLABLE_FEATURE_UNITS` 等) の変更は単独 PR にしない**。`withMeteredLLM` / drift 検知ロジックと **同一 PR にバンドル** すること (config 先行マージで drift 誤発火 + 既存テスト破壊の実績あり)。
- Client Component から config を import する場合、service の値 import 経由で Prisma が client bundle に混入し build 失敗する罠があります。閾値定数は `@/config/*` に分離してください。

### 2.2 service ロジックの変更

- テナント越境防止: 一覧系・取得系は `viewerTenantId` を必須引数で受け、`where.tenantId` フィルタを強制する ([design/SECURITY.md](../../design/SECURITY.md))。
- 変更系操作は `recordAuditLog()` を呼ぶ。`auditLog.entityId` は `@db.Uuid` 型なので、文字列識別子 (例 `'all-tenants'`) を入れると production で 22P02 エラーになります。横断操作は actor の `MANAGEMENT_TENANT_ID` を entityId に入れ、`afterValue.operation` で識別します。
- DB カラム撤去を伴う改修は 7+2 レイヤ grep が必須。`prisma.X.update({ data: {...} })` の `data` は XOR 型で excess property check が効かず、撤去カラム名がランタイム bomb 化します ([feedback 参照](../../knowledge/)).

### 2.3 route の変更

- 認可 (`getAuthenticatedUser` → `requireXxx` / `isSuperAdmin`)、検証 (Zod `safeParse`)、容量 pre-check の順序は KEY_FLOWS §1 のテンプレートに合わせる。
- 新規エラーコードを追加したら、それを握り潰す wrapper が無いか全 wrapper を grep する。エラーマッパー wrapper がコードを上位文言で握り潰す罠があります (例: storage quota wrapper が Beginner code を "50GB" 文言に置換)。

### 2.4 UI client の変更

- 機能修正は **UI で動くところまでが 1 単位**。service だけ直して画面に反映しないのは無価値です。
- `e2e/visual/` 対象画面 (settings / dashboard / customers / auth) の UI を変えたら `[gen-visual]` 空コミットで baseline を再生成する。

### 2.5 i18n の変更

- 文言変更は `ja.json` を編集し、必要なら `messages.test.ts` の `REQUIRED_*_KEYS` を更新する ([HOW_TO_ADD_FEATURES.md §8](./HOW_TO_ADD_FEATURES.md))。
- 姉妹コンポーネント間で placeholder の **意味** がズレていないか diff verify する (コード構造の一致だけでは不十分)。

---

## 3. リグレッション防止チェック

改修は「直したものが動く」だけでなく「それ以外が壊れていない」ことの確認が本体です。コミット前に [CLAUDE.md コミット前チェック](../../../CLAUDE.md) と [quality-check skill](../../../.claude/skills/quality-check.md) を実施します。

### 3.1 単体テスト

- `pnpm test` をローカル実行し差分が無いことを確認。テスト数の増減・旧文言残留もチェックする。
- 改修した service / route / validator のテストを同時に更新する (テスト変更を伴わないソース変更はコミットしない)。

### 3.2 E2E カバレッジ

- 新規 `route.ts` / `page.tsx` を追加したら [docs/test/E2E_COVERAGE.md](../../test/E2E_COVERAGE.md) に追記し、`pnpm e2e:coverage-check` をローカル実行する (lint/tsc/test/build の 4 点セットには含まれない別ガード)。

### 3.3 テナント分離 invariant

- 取得系・一覧系の改修では「他テナントのデータが混ざらないか」をテストで担保する。これは severity-1 (個人情報漏洩) リスクです。
- `tenant_id` に `@default(dbgenerated())` を **絶対に付けない** (silent な Default テナント混入の温床)。

### 3.4 課金 invariant (最重要)

課金関連を触ったら、以下の invariant が崩れていないことを確認します ([design/KEY_FLOWS.md §2](../../design/KEY_FLOWS.md) / [business/](../../business/README.md))。

- **ApiCallLog SUM (真値) = 画面表示 = 請求書 = CSV = Stripe** の全経路一致。counter はホットパスの上限チェック専用で、表示・請求には使わない。
- drift 検知は「両軸 (call / cost) の max + 画面表示 + audit + 修復経路」の 4 点セットで考える (単一軸は plan によって常に 0 になる軸があり silent fail する)。
- テナント関連フィルタは「現在値 / cron snapshot / 履歴クエリ」の 3 レイヤを同期修正する (CSV / ダッシュボード / 履歴 / cron の 4 経路を確認)。

---

## 4. 横展開チェックリスト

同じパターンが複数箇所にある場合、1 箇所だけ直すと残りが取り残されます。

- [ ] 同型の **姉妹コンポーネント** (例: chat-panel ↔ suggestions-panel) を 4 観点 (定数 / state / i18n placeholder / a11y) で diff verify し、同一 PR にバンドルした
- [ ] 同型の **route** が複数ある場合、全 route に同じ修正を適用した (例: CSV import の親スコープ制限が全 import route に入っているか)
- [ ] 階層エンティティの重複判定は `parent + name` で行っている (level + name だけだと別親で誤検知)
- [ ] grep 4 軸 (§0.1) で取りこぼしが無いことを再確認した
- [ ] config 変更はエンジン (`withMeteredLLM` / drift 検知) と同一 PR にした (§2.1)

---

## 5. 参照すべき設計文書

| 知りたいこと | 参照先 |
|---|---|
| データモデル・テーブル定義 | [design/DATA_MODEL.md](../../design/DATA_MODEL.md) |
| API 設計・認可・エラーコード | [design/API_DESIGN.md](../../design/API_DESIGN.md) |
| service 責務・一覧 | [design/SERVICES.md](../../design/SERVICES.md) |
| 状態遷移・enum・定数の真値 | [design/STATE_REFERENCE.md](../../design/STATE_REFERENCE.md) |
| config 定数の一覧と意味 | [design/CONFIGURATION.md](../../design/CONFIGURATION.md) |
| 主要フローの連結 (画面→route→service→DB→課金) | [design/KEY_FLOWS.md](../../design/KEY_FLOWS.md) |
| アーキテクチャ全体 | [design/ARCHITECTURE.md](../../design/ARCHITECTURE.md) |
| セキュリティ・テナント分離 | [design/SECURITY.md](../../design/SECURITY.md) |
| 画面仕様・権限マトリクス | [specification/SCREENS.md](../../specification/SCREENS.md) |
| ビジネスロジック (状態 / 課金 / ロール) | [business/](../../business/README.md) |
| 過去の罠・教訓 | [knowledge/](../../knowledge/) |
| 機能追加・削除・i18n の具体手順 | [HOW_TO_ADD_FEATURES.md](./HOW_TO_ADD_FEATURES.md) |
| テスト・lint・build の実行 | [TEST_LINT_BUILD.md](./TEST_LINT_BUILD.md) |
