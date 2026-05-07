# 6/1 リリース最終追加実装タスク (V1 Final Tasks)

本ドキュメントは、T-03 提案エンジン v2 の計画上の全 PR (PR #1〜#8) 完了後に、**6/1 リリースの必須スコープ**として追加実装する PR を集約する。

**前提**: T-03 提案エンジン v2 (PR #1〜#8) は完了。本ドキュメントはその後続作業のみを扱う。

関連: [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md) / [ROLE_REFACTORING_PLAN.md](./ROLE_REFACTORING_PLAN.md) / [T-03_RELEASE_NOTES.md](../operations/T-03_RELEASE_NOTES.md)

---

## 全体像

**最優先: 提案機能関連 (PR-X5 + PR-X6)** — サービスの核心機能。本日着手分から先頭に置く。

| 順序 | PR | 内容 | 工数 | 依存 |
|---|---|---|---|---|
| 1 | **PR-X5** | シードデータ大幅拡充 (案 C 採用 + Sample Projects/Issues/Retros) + 事前生成 embedding 同梱 + 既存データ backfill + 文書 (SEED_DATA_MAINTENANCE / VERIFICATION) | 2 日 | (なし、最優先で着手) |
| 2 | **PR-X6** | 提案 UI を段階表示 (Tiered) に変更 + 閾値撤廃 + **最低件数保証ロジック (0 件回避の構造保証)** | 2.5-3.5 日 | PR-X5 (backfill 後の embedding でテスト) |
| 3 | **PR-X1** | super_admin role + 管理テナント seed + 認可ヘルパ | 1-2 日 | (なし、PR-X5/X6 と並行可) |
| 4 | **PR-X2** | super_admin ダッシュボード UI (Phase 1) | 2-3 日 | PR-X1 |
| 5 | **PR-X4** | テナント管理者プラン変更 UI (`/settings` にタブ追加) | 2-3 日 | PR-X1 (認可ヘルパ流用) |
| 6 | **PR-X3** | UI 文言更新 + ドキュメント整合 | 1 日 | PR-X1〜X6 |

**合計**: 10.5-14.5 日 (PR-X5 が +0.5 日、PR-X6 が +0.5 日、案 C 採用 + 件数保証ロジック追加で)

**6/1 まで残**: 2026-05-07 起点で約 25 日 → **バッファ 11-15 日** (品質確認・視覚回帰・想定外修正対応に充当)。

```
[2026-05-07 着手] (本日)
   ↓
PR-X5 (1.5 日)         ← 最優先 (提案機能のデータ基盤)
   ↓
PR-X6 (2-3 日)         ← 提案 UI 段階表示化
   ↓
   並行で PR-X1 (1-2 日) を進めておく (PR-X5 着手と同時開始可能)
   ↓
PR-X2 ┐
PR-X4 ┤ 並行可能 (それぞれ 2-3 日、PR-X1 完了後)
   ↓
PR-X3 (1 日)
   ↓
[2026-05-17 〜 2026-05-20 完了見込]
   ↓
リリース直前テスト 約 11-15 日
   ↓
[2026-06-01 リリース]
```

### 優先順位の根拠

ユーザ指示 (2026-05-07): **「提案機能に関しては、最優先で着手するようにプランを変更してください」**。

提案機能は本サービスの差別化要素であり、6/1 リリース時点で「過去資産を全網羅し、見落としなく
未来のプロジェクト運営に活用できる」という体験を完成させる必要がある。
具体設計の根拠は memory `project_suggestion_engine_priority.md` を参照。

### 設計判断: シードデータ拡充は「案 C: 意味の濃さ優先」を採用 (2026-05-07)

ユーザ指示で「初めてのユーザが 1 件目にどんなプロジェクトを登録しても必ず hit する」が要件として
最重要視された。これに対する設計判断:

| 軸 | 採用方針 |
|---|---|
| シード規模 | **115 件** (SEED_KNOWLEDGE 50 + SAMPLE_PROJECTS 10 + SAMPLE_ISSUES 40 + SAMPLE_RETROSPECTIVES 15) で業界・技術・プロセスを網羅 |
| 文字数 | **意味の濃さ優先** (案 C 採用)。500-1000 字でも要点が濃く伝わる文章を目標とし、文字数を稼ぐ目的の冗長拡張は実施しない |
| 0 件回避の構造保証 | **PR-X6 で最低件数保証ロジック** を追加 (`MINIMUM_GUARANTEED_COUNT = 5`)。閾値以下でもスコア降順 Top N を必ず返す |
| 文書化 | [SEED_DATA_MAINTENANCE.md](../developer-guide/SEED_DATA_MAINTENANCE.md) で「embedding 向けに拾われやすい文章を書くコツ」を明文化。今後ユーザが追加するシードデータも同基準で運用 |

文字数を増やしても意味の濃さが上がるわけではない (= embedding 精度向上は頭打ち + ノイズ混入リスク)
ことが文字数測定 + 拾われやすさの観点で確認できたため、案 C を採用した。

詳細は [SEED_DATA_MAINTENANCE.md §3](../developer-guide/SEED_DATA_MAINTENANCE.md) を参照。

---

## PR-X1: super_admin role + 管理テナント + 認可ヘルパ (1-2 日)

詳細は [ROLE_REFACTORING_PLAN.md §3.1](./ROLE_REFACTORING_PLAN.md) 参照。

### 着手前の事前確認

| # | 項目 | 確定値 |
|---|---|---|
| 1 | 管理テナント名 | `Knowledge Relay Platform` |
| 2 | 管理テナント UUID | `00000000-0000-0000-0000-FFFFFFFFFFFF` |
| 3 | super_admin email | **`admin@knowledge-relay-platform.admin`** (確定) |
| 4 | tenantSeq 設計 | 案 D: default-tenant=1, 管理テナント=null, 新規顧客=2,3,4... (auto) |

### Vercel 環境変数 (teppei さん側、PR-X1 マージ前に登録必要)

```
SUPER_ADMIN_INITIAL_EMAIL=admin@knowledge-relay-platform.admin
SUPER_ADMIN_INITIAL_PASSWORD=<強固な初期パスワード、初回ログイン後に強制変更>
SUPER_ADMIN_INITIAL_NAME=Platform Admin
```

### 主な変更

| カテゴリ | 内容 |
|---|---|
| schema migration | `User.systemRole` に `'super_admin'` 許容 + `Tenant.tenantSeq` (`Int? @unique`) 追加 + SEQUENCE `tenants_tenant_seq_seq START WITH 2` |
| 管理テナント seed | UUID `...FFFFFFFFFFFF` の Tenant レコード作成 |
| 初期 super_admin | env 変数経由で User 作成、`forcePasswordChange=true` |
| 認可ヘルパ | `src/lib/permissions/role.ts` に `isSuperAdmin` / `isAdminOrAbove` / `requireSuperAdmin` |
| 既存コードの選択的置換 | 「全テナント横断で見たい」用途の `=== 'admin'` を `isSuperAdmin()` に置換 |

---

## PR-X2: super_admin ダッシュボード UI Phase 1 (2-3 日)

詳細は [ROLE_REFACTORING_PLAN.md §3.2](./ROLE_REFACTORING_PLAN.md) 参照。

### ルート

| URL | 内容 |
|---|---|
| `/admin/super/tenants` | 全テナント一覧 (`tenantSeq` 昇順、テナント名 / プラン / 月次 API 呼び出し数 / 月次費用 / アクティブユーザ数 / 作成日) |
| `/admin/super/tenants/[id]` | テナント詳細 (使用量推移グラフ / DB 容量内訳 / entity 数集計) |
| `/admin/super/usage` | 全テナント横断使用量サマリ (Voyage 200M 残量 / Anthropic 月次費用 / Supabase DB 容量) |

### サーバ実装

- `src/services/super-admin.service.ts` (新規) — テナント横断クエリ、`requireSuperAdmin` でガード
- 既存 `/api/admin/usage-summary` (PR #7) を活用 + 拡張
- E2E (`super_admin-dashboard.spec.ts`) で権限境界 (admin / general はアクセス拒否) 確認

---

## PR-X4: テナント管理者プラン変更 UI (2-3 日)

新規追加 PR。テナント管理者 (`systemRole='admin'`) が自テナントのプラン・予算上限を **画面から self-service 変更** できる。

### アクセスルート (案 B 採用)

```
URL: /settings (既存ページにタブ追加)
画面: [タブ] 個人設定 | 🆕 テナント設定 (admin のみ表示)
```

### タブ内容

#### 1. 現在のプラン表示
- Beginner / Expert / Pro バッジ + 月額固定費 / per-call 料金
- 適用日時 (`createdAt` または最後の変更日)

#### 2. プラン変更操作
- ラジオボタン: Beginner / Expert / Pro
- 変更時の挙動:
  - **アップグレード** (Beginner → Expert / Pro、Expert → Pro): 即時反映 (確認 dialog → API → 即適用)
  - **ダウングレード** (Pro → Expert / Beginner、Expert → Beginner): 翌月適用 (`scheduledPlanChangeAt` + `scheduledNextPlan` セット)
  - **Beginner ダウングレード時**: 席数 ≤ 5 でないと UI で拒否 (確認 dialog で「先に席数を 5 以下に減らしてください」)
  - **確認 dialog**: 「ダウングレードはこの月の月末から適用されます。当月分の従量課金は通常通り発生します」を明示

#### 3. 月次予算上限 (`monthlyBudgetCapJpy`) 設定
- 数値入力フォーム (例: 5000 円)
- null (= 無制限) との切替トグル
- 保存ボタン → API → DB 反映
- `withMeteredLLM` ミドルウェアが次回呼び出しから新しい上限を見る

#### 4. 当月残予算可視化
- 当月の累計コスト (`currentMonthApiCostJpy`) / 上限の bar グラフ
- 残予算金額表示
- 80% / 100% / 150% 到達済の場合は警告バナー

#### 5. 月次予約変更の取消
- ダウングレード予約済の場合、「予約を取消す」ボタンを表示
- 取消すと `scheduledPlanChangeAt = NULL` で月初 cron が動作しない

### サーバ実装

- `PATCH /api/tenants/me` (新規) — 自テナントの plan / monthlyBudgetCapJpy / scheduledPlanChangeAt を更新
- 認可: `systemRole === 'admin'` (PR-X1 の `isAdminOrAbove` ヘルパを流用)
- バリデーション: ダウングレード時の席数チェック

### テスト

- 単体: API ルートの認可・バリデーション
- 統合: 「アップグレードは即時反映」「ダウングレードは翌月適用」「席数超過時の拒否」のシナリオ

---

## PR-X5: シードデータ拡充 (案 C 採用 + embedding 事前生成、2 日)

> **2026-05-07 更新**: 当初計画 (1.5 日) からスコープ拡張。SAMPLE_PROJECTS 10 件 / SAMPLE_ISSUES 40 件 / SAMPLE_RETROSPECTIVES 15 件 / SEED_KNOWLEDGE 30→50 件 + 文書 ([SEED_DATA_MAINTENANCE.md](../developer-guide/SEED_DATA_MAINTENANCE.md) / [SUGGESTION_ENGINE_VERIFICATION.md](../operations/SUGGESTION_ENGINE_VERIFICATION.md)) を含めて 2 日。
>
> **シードデータの文字数方針 (案 C)**: 各 entry 500-1000 字で要点が濃く伝わることを目標。1500 字超の冗長拡張は逆効果のため実施しない。詳細は [SEED_DATA_MAINTENANCE.md §3](../developer-guide/SEED_DATA_MAINTENANCE.md) を参照。

**ユーザの認識**: 提案機能は本サービスの根幹機能。初期データはユーザが評価する際の重要なデータ。妥協できない。

> **2026-05-07 追記 (5-7 として scope 追加)**: 初期データに事前生成 embedding を同梱することで、新規テナントが Day 1 から 3 軸スコアリング (tag 0.3 + pg_trgm 0.2 + **embedding 0.5**) のフル精度で提案を体験できるようにする。embedding は本サービスの提案精度の主軸 (重み 50%) であるため、ここを欠くと初期体験が大きく劣化する。

### 案 C のスコープ

#### 5-1. シードナレッジの修正 (現状分の問題対応)

| 問題 | 対応 |
|---|---|
| `knowledgeType` が enum 外の値 (`lesson_learned` / `pattern`) で UI が日本語ラベルにマッピング失敗 | 全 30 件を `lesson` (教訓) / `best_practice` (ベストプラクティス) に修正 |
| 内容が短く、embedding ヒット率が低い (1 件あたり 200-500 字) | 各エントリ 1000-2000 字に拡充 (background / content / result / recommendation を充実化) |

#### 5-2. 課題シードの追加 (10-15 件)

```
default-tenant
├─ Project: "Sample Project A (シード用)" (isSampleData=true)
│   ├─ resolved Issue: 「決済 API のリトライで二重課金が発生した件」 (Knowledge #6 と紐付く事例)
│   ├─ resolved Issue: 「ユーザ一覧画面の N+1 で 1 秒以上の遅延」 (Knowledge #7 と紐付く)
│   ├─ resolved Issue: 「キャッシュの無効化漏れで 5 分間古いデータ表示」 (Knowledge #8 と紐付く)
│   ├─ resolved Issue: 「外部 API 障害でアプリ全体が応答しなくなった」 (Knowledge #9 Circuit Breaker と紐付く)
│   ├─ resolved Issue: 「サマータイム導入国ユーザの時刻表示ずれ」 (Knowledge #10 TZ と紐付く)
│   └─ ...
└─ Project: "Sample Project B (シード用)" (isSampleData=true)
    ├─ resolved Issue: 「金曜午後デプロイで週末対応に追われた」 (Knowledge #18 と紐付く)
    ├─ resolved Issue: 「バックアップ復元失敗で災害対策が機能せず」 (Knowledge #19 と紐付く)
    └─ ...
```

各 Issue に:
- title (50-80 字)
- content (800-1500 字、具体的な状況・対応・結果)
- result (500-1000 字、実際にどう解決したか)
- lessonLearned (200-500 字、次回に向けた教訓)
- 適切な impact / likelihood / priority

#### 5-3. 振り返りシードの追加 (5-7 件)

```
├─ Sample Project A
│   ├─ Retrospective: "Sprint 5 振り返り — Brooks の法則を実体験"
│   ├─ Retrospective: "Q1 振り返り — スコープクリープによる遅延"
│   └─ Retrospective: "リリース後振り返り — 監視不足の教訓"
└─ Sample Project B
    ├─ Retrospective: "Phase 1 振り返り — マイクロサービス化の挫折"
    └─ Retrospective: "本番障害振り返り — Circuit Breaker 導入の決断"
```

各 Retro:
- planSummary (300-500 字)
- actualSummary (500-1000 字)
- goodPoints (500-1000 字)
- problems (500-1000 字、具体的な課題)
- improvements (500-1000 字、次回への改善案)

#### 5-4. サンプルプロジェクト隠蔽機構

##### Schema migration

```sql
ALTER TABLE projects ADD COLUMN is_sample_data BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX idx_projects_is_sample_data ON projects(is_sample_data) WHERE is_sample_data = true;
```

##### 隠蔽ロジック

| 画面 / 機能 | サンプルデータ可視性 |
|---|---|
| プロジェクト一覧 (`/projects`) | ❌ 非表示 (WHERE is_sample_data=false) |
| プロジェクト詳細 (`/projects/[id]`) | ❌ 404 (admin が直接 URL 入力しても表示しない) |
| 全課題 (`/risks`) / 全リスク / 全振り返り横断 view | ❌ 非表示 (parent project の is_sample_data でフィルタ) |
| プロジェクト詳細内の課題タブ・リスクタブ・振り返りタブ | (該当なし、サンプルプロジェクト自体が表示されないため) |
| **提案エンジン (参考タブ / 提案モーダル)** | ✅ **表示** (これが目的、提案候補として機能) |
| API 集計 (`/api/admin/usage-summary`) | ✅ 表示 (運用上の透明性) |
| seedTenant() による新規テナント clone | ✅ コピー (新規テナントもサンプルデータ + 隠蔽機構の両方を継承) |

##### 影響範囲のコード変更箇所 (推定)

- `src/services/project.service.ts` の listProjects() 等に `where: { isSampleData: false }` 追加
- `src/services/risk.service.ts` の listAllRisksForViewer() に parent project の isSampleData フィルタ追加
- `src/services/retrospective.service.ts` の listAllRetrospectivesForViewer() に同様
- `src/app/(dashboard)/projects/[projectId]/page.tsx` で isSampleData=true の場合 notFound() 呼出
- `prisma/seed-suggestion.ts` で sample projects 作成 + isSampleData=true 設定 + issues/retros 紐付け
- `prisma/seed-suggestion.ts` の `seedTenant()` を sample projects/issues/retros の clone 対応に拡張

#### 5-5. ヒット率向上のための内容拡充

シードナレッジ各エントリの文字数増:
- 現状: title + background + content + result + conclusion + recommendation = 約 200-500 字
- 目標: **約 1000-2000 字** (各セクション充実化)

ヒット率向上の理由:
- pg_trgm 軸: 文字数が多いほどキーワードマッチの確率上昇
- embedding 軸: 文脈情報が増え、意味類似度の解像度が上がる
- 結果として、ユーザのプロジェクト記述と提案候補の マッチ精度が向上

具体的な拡充例 (Brooks の法則):

```
[現状 ~150 字]
背景: リリース直前のプロジェクトで遅延が発生し、追加メンバーの投入で挽回しようとしたが、教育コスト・コミュニケーションオーバーヘッドが先行して結果的にさらに遅延した。

[拡充後 ~600 字]
背景: 受託開発のプロジェクトで、リリース 1 ヶ月前に進捗が予定の 70% であることが
判明。クライアントへの納期コミットを守るため、急遽 4 名の追加メンバー (うち 2 名は
新規採用、2 名は他プロジェクトからのリソース移動) を投入した。

しかし投入直後から想定外の事態が連続: (1) 新規 2 名の環境セットアップに 3 日を要し、
さらに 2 週間は単独で生産性を発揮できなかった、(2) 既存メンバーが新メンバーへの
教育・コードレビューに 1 日 2-3 時間奪われ、本来の開発業務が圧迫された、(3) チーム
内のコミュニケーションパスが 4 → 8 名で 2 倍以上に増え、毎日のスタンドアップが
30 分 → 90 分に肥大化した。

結果として、当初想定の 2 週間遅延が 4 週間に拡大。クライアントとの調整再交渉が
発生し、契約上のペナルティ条項にも触れる事態となった。
```

このような拡充を 30 件すべてに適用。

#### 5-6. 検証 (基本)

- 単体テスト追加: サンプルプロジェクトが各リスト view から除外されること
- 単体テスト追加: 提案エンジンではサンプルプロジェクトの issues/retros が候補に含まれること
- 単体テスト追加: 事前生成 JSON が読まれて embedding 列に書込まれること
- 単体テスト追加: JSON 不在 / キー不在時に NULL で投入されること (warning 出力)
- 統合テスト: seedTenant() が sample projects も含めて clone し embedding がコピーされること
- 視覚回帰: 提案モーダルでサンプル候補が表示されることを確認

#### 5-7. 事前生成 embedding 同梱 + 既存データ backfill (2026-05-07 追加)

##### 動機

現状 (PR #6 実装) のシードデータは `content_embedding = NULL` で投入される。結果として:
- 新規テナントが提案画面を開いた時、シード候補すべてに対し embedding 軸 (重み **0.5**) がゼロ化
- タグ 0.3 + pg_trgm 0.2 = 合計 **0.5 の縮退モード**で動作
- 検索精度の主軸 (= 意味検索) が機能せず、「過去資産が結びつく体験」の核心価値が初期から伝わりにくい

加えて、`Knowledge.contentEmbedding` 等は **新規作成 / 更新時にしか生成されない** ため、
**既存データ (本番に既に存在する 60+ 件) は永久に NULL のまま** = 縮退モードで運用される。

→ 以下の 2 段構えで対処する:
1. **シードデータに事前生成済 embedding を同梱** (新規テナントが Day 1 から 3 軸フル精度を体験)
2. **本番既存データへの backfill コマンド** (本リポジトリ運用済テナントの過去資産も embedding 化)

##### 実装構成

```
prisma/
├─ seed-suggestion.ts                     # 既存 (拡充 + JSON 読込ロジック追加)
├─ seed-suggestion-embeddings.json        # 新規 (生成済 embedding をリポジトリにコミット)
└─ ...

scripts/
└─ generate-seed-embeddings.ts            # 新規 (開発者環境で 1 回実行)
                                          # --backfill-existing で本番既存データの embedding も生成

package.json:
  "seed:generate-embeddings": "tsx scripts/generate-seed-embeddings.ts"
```

##### ワークフロー

```
[A. 開発者環境での生成 (1 回限り、新規シード追加・更新時のみ再実行)]
  1. .env.local に VOYAGE_API_KEY 設定
  2. pnpm seed:generate-embeddings 実行
     → SEED_KNOWLEDGE / SEED_ISSUES / SEED_RETROSPECTIVES の各エントリで Voyage API 呼出
     → seed-suggestion-embeddings.json に { entityType: { entry_key: [1024 floats] } } で保存
  3. JSON ファイルを git commit (リポジトリに格納)

[B. 本番 seed 投入時 (Vercel build / pnpm db:seed:suggestion)]
  → SEED_KNOWLEDGE 等を INSERT
  → seed-suggestion-embeddings.json から該当 embedding 読込
  → raw SQL で content_embedding 列に書込 (Prisma の Unsupported("vector(1024)") のため $executeRaw)
  → 結果: 全シードデータに embedding 付き

[C. 新規テナント招待時 (seedTenant())]
  → default-tenant の Knowledge / Issue / Retrospective を読込 (embedding 付き)
  → 新規テナントへ INSERT (embedding ごとコピー、既存実装どおり)
  → 結果: 新規テナントも Day 1 から 3 軸スコアリングフル稼働

[D. 本番既存データの backfill (1 回限り、teppei さん側で実行)]
  → pnpm seed:generate-embeddings --backfill-existing を本番 DB 接続情報で実行
  → 全 Knowledge / RiskIssue / Retrospective / Project を走査し、embedding=NULL の行に対して
    Voyage API でベクトル生成 → DB へ直接書込
  → 結果: 既存「請求書発行システム構築」プロジェクト等で提案が 0 件 → 多数件に改善
```

##### キー設計

JSON ファイルのエントリキー = **`title` の SHA-256 ハッシュ先頭 16 文字**:
- 同じタイトルなら同じキー (冪等)
- タイトル変更時は新キーになり、JSON に該当キーがなければ INSERT 時に embedding=NULL でスキップ (= 再生成漏れを警告ログで検知可能)

##### JSON 構造例

```json
{
  "knowledges": {
    "abc123def4567890": [0.012, -0.453, 0.781, ...]
  },
  "issues": {
    "def456abc7890123": [0.234, 0.567, -0.123, ...]
  },
  "retrospectives": {
    "789abc123def4567": [-0.123, 0.456, 0.789, ...]
  }
}
```

##### Voyage API コスト試算

```
[シード生成]
SEED_KNOWLEDGE (30 件) + SEED_ISSUES (10-15 件) + SEED_RETROSPECTIVES (5-7 件)
≒ 50 件 × 平均 1500 token = 75,000 token

[既存 backfill (本番)]
既存 Knowledge 60+ 件 + Project 数件 + Issues / Retros (テナント蓄積分)
≒ 100 件 × 平均 1500 token = 150,000 token

合計 ≒ 225,000 token (無料枠 200M token のうち 0.11%) → 実質コストゼロ
```

##### 想定外シナリオへの対応

| 状況 | 対応 |
|---|---|
| seed-suggestion-embeddings.json に該当キーがない (= シード追記後に再生成漏れ) | INSERT 時に embedding=NULL で投入 + console.warn で警告。後追いで `pnpm seed:generate-embeddings` 実行で復旧 |
| Voyage API キー未設定で `pnpm seed:generate-embeddings` 実行 | 明示的にエラー終了、適切なメッセージ表示 |
| Voyage モデル変更 (例: voyage-4-lite → voyage-5-lite) | 開発者が `pnpm seed:generate-embeddings` を再実行 + 新 JSON をコミット (ベクトル次元が変わる場合は migration も必要だが本リリース範囲外) |
| 本番 backfill が中断 (rate limit / ネットワーク障害) | スクリプトは冪等 (embedding=NULL の行のみ処理) のため再実行で続行可能 |

##### 工数内訳

- generate-seed-embeddings.ts 実装 + テスト: 0.3 日
- seed-suggestion.ts の JSON 読込 + raw SQL embedding 書込: 0.2 日
- `--backfill-existing` モード実装 (既存データ走査 + DB 直接書込): 0.1 日
- 単体テスト追加 (JSON 不在時 / キー不在時のフォールバック / backfill モード): 0.1 日

合計 **0.5 日強** (PR-X5 全体は元の 1 日 + 0.5 日 = **1.5 日**)。

#### 5-8. 検証 (拡充)

提案機能の効果を定量検証するため、以下を before/after で記録:

- **検証対象プロジェクト**: 既存「請求書発行システム構築」(2026-05-07 時点で提案 0 件) +
  新規作成のサンプルプロジェクト 2-3 件
- **before スクショ**: 改修前の「ナレッジ候補 0 件 / 過去課題 0 件 / 過去振り返り 0 件」を保存
- **after スクショ**: PR-X5 + PR-X6 完了後の段階表示画面を保存
- **数値計測**:
  - 提案件数 (各セクションごと: strong / medium / weak)
  - 高スコア候補の関連性 (人間判断で「妥当」な比率)
  - API 応答時間 (50 件表示時、500ms 以下が目安)
- **記録先**: `docs/operations/SUGGESTION_ENGINE_VERIFICATION.md` に before/after を残す

---

## PR-X6: 提案 UI を段階表示 (Tiered) に変更 + 閾値撤廃 + 最低件数保証 (2.5-3.5 日)

**追加日**: 2026-05-07 (件数保証ロジックを 2026-05-07 のユーザ要望で追加)
**着手順序**: PR-X5 完了直後 (PR-X5 で backfill された embedding で動作確認するため)

### 背景

PR-X5 までは `SUGGESTION_SCORE_THRESHOLD = 0.05` で「明らかに関連するもののみ提案する」
高精度・低再現率の設計だった。しかし本サービスの存在意義は **「人間が探さずに済む」
「取りこぼし防止」** であり、高精度設計はこの哲学と矛盾する (= 弱関連を見るには結局
人間が検索する必要が残る)。

設計方針を **「全網羅 + 段階表示」** の高再現率設計に変更する。詳細は
memory `project_suggestion_engine_priority.md` を参照。

### スコープ

#### 6-1. 設定値変更 ([src/config/suggestion.ts](../../src/config/suggestion.ts))

| 定数 | 現状 | 変更後 | 理由 |
|---|---|---|---|
| `SUGGESTION_SCORE_THRESHOLD` | `0.05` | `0.01` (実質ゼロ寄り、完全撤廃でも可) | 全網羅のため閾値を実質撤廃 |
| `SUGGESTION_DEFAULT_LIMIT` | `10` | `50` | 件数上限を緩和 (段階表示で可読性は確保) |
| (新規) `SUGGESTION_TIER_STRONG_THRESHOLD` | — | `0.3` | strong セクションのしきい |
| (新規) `SUGGESTION_TIER_MEDIUM_THRESHOLD` | — | `0.1` | medium セクションのしきい |
| (新規) `SUGGESTION_MINIMUM_GUARANTEED_COUNT` | — | `5` | **最低件数保証** (閾値以下でもスコア降順 Top N を必出) |

スコアリング式 (タグ 0.3 + pg_trgm 0.2 + embedding 0.5) は **変更しない** (デグレ防止)。

#### 6-1-bis. 最低件数保証ロジック (2026-05-07 追加 / ユーザ要望)

**ユーザ要望**: 「初めてのユーザが 1 件目にどんなプロジェクトを登録しても必ず hit する。提案件数が 0 件とならないように考慮」。

シードデータ拡充 (PR-X5) + 段階表示 (PR-X6 6-1) で大幅に改善されるが、**極端なケース** (シードと完全に異なる業務領域・タグ表記揺れの全方向不一致) で 0 件になる構造リスクが残る。これを構造保証するため:

```typescript
// suggestion.service.ts (擬似コード)
const candidates = await searchCandidates(...);  // 既存ロジック
const aboveThreshold = candidates.filter(c => c.score >= SUGGESTION_SCORE_THRESHOLD);

if (aboveThreshold.length >= SUGGESTION_MINIMUM_GUARANTEED_COUNT) {
  return aboveThreshold;  // 通常パス: 閾値以上で十分な件数あり
}

// 最低件数保証: 閾値以下も含めスコア降順 Top N を返す
return candidates.slice(0, SUGGESTION_MINIMUM_GUARANTEED_COUNT);
```

**動作仕様**:
- 候補総数が `SUGGESTION_MINIMUM_GUARANTEED_COUNT` 以下なら全件返す (上記 if-else は不要)
- 閾値以上の候補が 5 件未満でも、スコア降順で Top 5 (最低 5 件) を必ず返す
- 段階表示時は弱関連 (weak tier) セクションに分類 → ユーザに「関連性低い」と明示しつつ取りこぼし防止

**前提**: シードデータが本テナントに最低 5 件投入されていること (PR-X5 で SAMPLE 系 + SEED_KNOWLEDGE で 100 件以上が default-tenant に存在)。

#### 6-2. サービス層変更

[src/services/suggestion.service.ts](../../src/services/suggestion.service.ts) のレスポンス DTO に
`tier` フィールドを追加:

```typescript
type SuggestionTier = 'strong' | 'medium' | 'weak';

interface SuggestionItem {
  id: string;
  title: string;
  score: number;
  tier: SuggestionTier;  // 新規
  // ... 既存フィールド
}
```

クエリ自体は **大きな変更不要** (既にスコア降順で取得しているため、件数上限と閾値の
緩和のみで段階表示の入力データが揃う)。

#### 6-3. フロントエンド変更

提案タブを **3 セクション + 折りたたみ** に改修:

```
┌─ 提案ナレッジ ─────────────────────────────────┐
│                                                  │
│ 🟢 強く関連 (3 件)                ← score >= 0.3 │
│   • PowerPlatform を使った請求書発行...          │
│   • 請求書発行は冪等に + 改ざん不可ログ          │
│   • SAP 連携時の認証パターン                      │
│                                                  │
│ 🟡 関連する可能性 (8 件)        ← score 0.1-0.3 │
│   • Conway の法則 — 組織構造がシステム構造を...  │
│   • [展開ボタン: あと 5 件を表示]                │
│                                                  │
│ ⚪ 弱い関連性 (24 件)            ← score < 0.1  │
│   [折りたたみ: クリックで展開]                   │
│                                                  │
└──────────────────────────────────────────────────┘
```

設計指針:
- 各セクションに **件数バッジ** を表示 (ユーザが量を把握できる)
- weak セクションは **折りたたみデフォルト** (情報過多回避)
- セクション内は **スコア降順**
- 同様の UI を「過去課題」「過去振り返り」にも適用

#### 6-4. デグレ防止策

- 既存テスト ([src/services/suggestion.service.test.ts](../../src/services/suggestion.service.test.ts))
  を全件パスさせる
- 段階表示の新規テスト (DTO に tier が付与される / 閾値ゾーン境界の振り分け) を追加
- **feature flag** (`SUGGESTION_DISPLAY_MODE=tiered|legacy`) で並行運用 → 検証後に切替
  - default: `tiered` (新方式)
  - 緊急時に `legacy` で旧 UI に即時戻せる
- 既存スコアリング計算は **そのまま** (重み 0.3 / 0.2 / 0.5 を変更しない)

#### 6-5. パフォーマンス検証

- 候補数増加 (10 → 50) で N+1 / クエリ時間が悪化しないか測定
- pgvector 索引 (IVFFlat / HNSW) が想定通り効いているか確認
- 目標: API 応答時間 500ms 以下 (本番に近いデータ量で計測)

#### 6-6. LP / ドキュメント文言の見直し

PR-X3 と分担し、以下を **PR-X6 内で完了** させる:
- 提案画面の文言 (「明らかに関連するもの」表現があれば修正)
- [docs/specification/SUGGESTION_FEATURE.md](../specification/SUGGESTION_FEATURE.md) の
  「網羅性重視」方針への書き換え

### 完了条件

- [ ] 設定変更が反映され、既存データで weak セクションも候補が出る
- [ ] 3 セクション UI が画面で動作 (件数バッジ + 折りたたみ + ソート)
- [ ] **最低件数保証ロジック** が動作 (シードと完全に違う業務領域でも Top 5 が返ること)
- [ ] 既存テスト全件 PASS + 新規テスト追加 (件数保証のテストも含む)
- [ ] feature flag で legacy にロールバック可能
- [ ] パフォーマンス API 応答時間 ≤ 500ms (50 件表示時)
- [ ] LP 文言・仕様書ドキュメントを「網羅性」「段階表示」基調に更新

---

## PR-X3: UI 文言 + ドキュメント (1 日)

詳細は [ROLE_REFACTORING_PLAN.md §3.3](./ROLE_REFACTORING_PLAN.md) 参照。

### 主な変更

| 対象 | 変更内容 |
|---|---|
| UI Badge 表示 | 「管理者」→「**テナント管理者**」 / 「**システム管理者**」(super_admin の場合) |
| `/settings` のテナント設定タブ | 文言確認 (PR-X4 で実装済の文言レビュー) |
| `/admin/super/*` の文言 | super_admin ダッシュボードの文言確認 |
| `docs/specification/PERMISSION_MATRIX.md` | 3 ロール対応に更新 |
| `docs/business/USER_ROLES.md` | super_admin の役割定義追加 |
| `docs/specification/SUGGESTION_FEATURE.md` | 監視責務の主体を super_admin と明示 |
| `docs/operations/SECURITY_OPS.md` | super_admin 運用手順 (パスワード初期化 / ローテーション) |
| `docs/operations/T-03_RELEASE_NOTES.md` | 起動前チェックリストに super_admin / サンプルデータ確認を追加 |
| `CLAUDE.md` | 役割の再解釈について簡潔な注記 |

---

## 完了条件 (Definition of Done) — 6/1 リリースまでに

### コード

- [ ] PR-X5: シードナレッジ拡充 30 件 + サンプル課題 10-15 件 + サンプル振り返り 5-7 件 + 隠蔽機構 + **事前生成 embedding 同梱 (seed-suggestion-embeddings.json + generate-seed-embeddings.ts) + 既存データ backfill**
- [ ] PR-X6: 段階表示 (Tiered) UI + 閾値撤廃 + DTO に tier + feature flag で legacy ロールバック可能
- [ ] PR-X1: schema migration + seed + 認可ヘルパ + 既存テスト維持
- [ ] PR-X2: super_admin ダッシュボード 3 画面 + 認可境界 E2E
- [ ] PR-X4: テナント管理者プラン変更 UI + 認可・バリデーション・ダウングレード遅延適用
- [ ] PR-X3: UI 文言 + ドキュメント整合

### 検証

- [ ] `pnpm test` 全件 PASS (PR-X5/X6 で +30 件程度の test 追加見込)
- [ ] `pnpm lint` clean
- [ ] `pnpm tsx scripts/security-check.ts` ≥ 90/100
- [ ] `pnpm e2e:coverage-check` 全カバー
- [ ] super_admin 用 Vercel 環境変数 3 件 (teppei さん) 設定済
- [ ] 本番に対する seed 実行で 30 ナレッジ + 2 サンプルプロジェクト + 課題 + 振り返り が投入済
- [ ] 本番既存データ (60+ 件) に対する embedding backfill 実行済
- [ ] 提案 API 応答時間 ≤ 500ms (50 件表示時、本番データで計測)

### UX 検証 (teppei さん)

- [ ] 新規プロジェクト作成 → 自動タグ抽出 → 提案モーダルで「過去資産が結びつく」体験を確認
- [ ] 提案候補が **段階表示 (strong / medium / weak) で出る**ことを確認
- [ ] 既存「請求書発行システム構築」プロジェクトで提案が **0 件 → 多数件** に改善することを確認
- [ ] 提案候補に **ナレッジだけでなく課題・振り返りが現れる**ことを確認
- [ ] サンプルプロジェクトが `/projects` リストに表示されないことを確認
- [ ] テナント管理者として `/settings` のテナント設定タブで予算上限を設定できることを確認
- [ ] super_admin として `/admin/super/tenants` で全テナント状況を確認できることを確認

### 検証エビデンスの保管

- [ ] 改修 before / after のスクショを `docs/operations/SUGGESTION_ENGINE_VERIFICATION.md` に記録
- [ ] 数値計測 (件数・関連性比率・応答時間) を同ドキュメントに記録

---

## 着手順序のリマインダ

```
本日 (2026-05-07) 着手:
  最優先トラック (提案機能):
    1. PR-X5 (シードデータ拡充 + 事前生成 embedding 同梱 + 既存データ backfill、1.5 日)
       完了見込: 2026-05-08 中
    2. PR-X6 (段階表示 UI + 閾値撤廃、2-3 日)  ← PR-X5 完了後
       完了見込: 2026-05-11 〜 12

  並行トラック (ロール再構築):
    3. PR-X1 (super_admin schema + 認可、1-2 日)  ← PR-X5 と同時着手可能
       完了見込: 2026-05-08 〜 09
    4. PR-X2 (super_admin ダッシュボード、2-3 日)  ← PR-X1 完了後
    5. PR-X4 (テナント管理者プラン変更 UI、2-3 日)  ← PR-X1 完了後
       PR-X2 と PR-X4 は並行可

  最後:
    6. PR-X3 (UI 文言 + ドキュメント、1 日)  ← 全 PR 完了後
       完了見込: 2026-05-17 〜 2026-05-20
```

**PR-X5/X6 を提案機能トラックとして最優先扱い** とする。理由は本ドキュメント冒頭
「優先順位の根拠」を参照。

PR-X4 と PR-X5 を同時着手しないこと (PR-X4 は admin 認可ヘルパに依存)。
PR-X1 と PR-X5 は依存ゼロで並行着手可能。

PR-X5 の `pnpm seed:generate-embeddings` 実行は **開発者環境 (teppei さん側)** で `.env.local` に `VOYAGE_API_KEY` を設定して 1 回実行 → 生成された JSON を repo に commit する手順となる。本作業は PR-X5 内で自動化スクリプトを整備するのみで、生成は teppei さん側のアクション。

---

## 関連ドキュメント

| ファイル | 役割 |
|---|---|
| [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md) | T-03 提案エンジン v2 の PR #1〜#8 計画 (完了済) |
| [ROLE_REFACTORING_PLAN.md](./ROLE_REFACTORING_PLAN.md) | super_admin role の詳細設計 (PR-X1/X2/X3) |
| [TENANT_AND_BILLING.md Part 5](../business/TENANT_AND_BILLING.md) | 課金モデル詳細 (PR-X4 の根拠) |
| [SUGGESTION_FEATURE.md](../specification/SUGGESTION_FEATURE.md) | 提案機能の機能仕様 + コスト構造 (PR-X5/X6 の根拠) |
| [T-03_RELEASE_NOTES.md](../operations/T-03_RELEASE_NOTES.md) | リリース運用ガイド (本タスク完了後に最終更新) |
| `SUGGESTION_ENGINE_VERIFICATION.md` (新規) | PR-X5/X6 改修の before/after エビデンス記録 (operations 配下に追加予定) |
