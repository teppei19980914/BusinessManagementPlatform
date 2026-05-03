# 6/1 リリース最終追加実装タスク (V1 Final Tasks)

本ドキュメントは、T-03 提案エンジン v2 の計画上の全 PR (PR #1〜#8) 完了後に、**6/1 リリースの必須スコープ**として追加実装する PR を集約する。

**前提**: T-03 提案エンジン v2 (PR #1〜#8) は完了。本ドキュメントはその後続作業のみを扱う。

関連: [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md) / [ROLE_REFACTORING_PLAN.md](./ROLE_REFACTORING_PLAN.md) / [T-03_RELEASE_NOTES.md](../operations/T-03_RELEASE_NOTES.md)

---

## 全体像

| 順序 | PR | 内容 | 工数 | 依存 |
|---|---|---|---|---|
| 1 | **PR-X1** | super_admin role + 管理テナント seed + 認可ヘルパ | 1-2 日 | (なし) |
| 2 | **PR-X2** | super_admin ダッシュボード UI (Phase 1) | 2-3 日 | PR-X1 |
| 3 | **PR-X4** | テナント管理者プラン変更 UI (`/settings` にタブ追加) | 2-3 日 | PR-X1 (認可ヘルパ流用) |
| 4 | **PR-X5** | シードデータ拡充 (案 C: 課題・振り返り追加 + サンプルプロジェクト隠蔽 + ヒット率向上) | 1 日 | (独立、並行可) |
| 5 | **PR-X3** | UI 文言更新 + ドキュメント整合 | 1 日 | PR-X1〜X5 |

**合計**: 7-10 日

**6/1 まで残**: 2026-05-04 起点で約 28 日 → **十分なバッファ** (品質確認・視覚回帰・想定外修正対応に約 18-21 日)。

```
[2026-05-04 着手]
   ↓
PR-X1 (1-2 日)  ← 起点
   ↓
PR-X2 ┐
PR-X4 ┤ 並行可能 (それぞれ 2-3 日)
PR-X5 ┘
   ↓
PR-X3 (1 日)
   ↓
[2026-05-13 前後 完了見込]
   ↓
リリース直前テスト 約 18-21 日
   ↓
[2026-06-01 リリース]
```

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

## PR-X5: シードデータ拡充 (案 C 採用、1 日)

**ユーザの認識**: 提案機能は本サービスの根幹機能。初期データはユーザが評価する際の重要なデータ。妥協できない。

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

#### 5-6. 検証

- 単体テスト追加: サンプルプロジェクトが各リスト view から除外されること
- 単体テスト追加: 提案エンジンではサンプルプロジェクトの issues/retros が候補に含まれること
- 統合テスト: seedTenant() が sample projects も含めて clone すること
- 視覚回帰: 提案モーダルでサンプル候補が表示されることを確認

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

- [ ] PR-X1: schema migration + seed + 認可ヘルパ + 既存テスト維持
- [ ] PR-X2: super_admin ダッシュボード 3 画面 + 認可境界 E2E
- [ ] PR-X4: テナント管理者プラン変更 UI + 認可・バリデーション・ダウングレード遅延適用
- [ ] PR-X5: シードナレッジ拡充 30 件 + サンプル課題 10-15 件 + サンプル振り返り 5-7 件 + 隠蔽機構
- [ ] PR-X3: UI 文言 + ドキュメント整合

### 検証

- [ ] `pnpm test` 全件 PASS (PR-X5 で +20 件程度の test 追加見込)
- [ ] `pnpm lint` clean
- [ ] `pnpm tsx scripts/security-check.ts` ≥ 90/100
- [ ] `pnpm e2e:coverage-check` 全カバー
- [ ] super_admin 用 Vercel 環境変数 3 件 (teppei さん) 設定済
- [ ] 本番に対する seed 実行で 30 ナレッジ + 2 サンプルプロジェクト + 課題 + 振り返り が投入済

### UX 検証 (teppei さん)

- [ ] 新規プロジェクト作成 → 自動タグ抽出 → 提案モーダルで「過去資産が結びつく」体験を確認
- [ ] 提案候補に **ナレッジだけでなく課題・振り返りが現れる**ことを確認
- [ ] サンプルプロジェクトが `/projects` リストに表示されないことを確認
- [ ] テナント管理者として `/settings` のテナント設定タブで予算上限を設定できることを確認
- [ ] super_admin として `/admin/super/tenants` で全テナント状況を確認できることを確認

---

## 着手順序のリマインダ

```
明日 (2026-05-04) 着手:
  1. PR-X1 (super_admin schema + 認可) ← 起点
     完了見込: 2026-05-05 中

並行:
  2. PR-X2 (super_admin ダッシュボード)
  3. PR-X4 (テナント管理者プラン変更 UI)
  4. PR-X5 (シードデータ拡充 + 隠蔽)

最後:
  5. PR-X3 (UI 文言 + ドキュメント)
     完了見込: 2026-05-13 前後
```

PR-X4 と PR-X5 は **PR-X1 の認可ヘルパ完成後**に着手 (PR-X4 は admin 認可、PR-X5 はサンプル隠蔽の影響範囲確認に admin 動作確認が便利)。

---

## 関連ドキュメント

| ファイル | 役割 |
|---|---|
| [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md) | T-03 提案エンジン v2 の PR #1〜#8 計画 (完了済) |
| [ROLE_REFACTORING_PLAN.md](./ROLE_REFACTORING_PLAN.md) | super_admin role の詳細設計 (PR-X1/X2/X3) |
| [TENANT_AND_BILLING.md Part 5](../business/TENANT_AND_BILLING.md) | 課金モデル詳細 (PR-X4 の根拠) |
| [SUGGESTION_FEATURE.md](../specification/SUGGESTION_FEATURE.md) | 提案機能の機能仕様 + コスト構造 (PR-X5 の根拠) |
| [T-03_RELEASE_NOTES.md](../operations/T-03_RELEASE_NOTES.md) | リリース運用ガイド (本タスク完了後に最終更新) |
