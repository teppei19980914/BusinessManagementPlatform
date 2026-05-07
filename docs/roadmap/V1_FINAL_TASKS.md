# 6/1 リリース最終追加実装タスク (V1 Final Tasks)

本ドキュメントは、T-03 提案エンジン v2 の計画上の全 PR (PR #1〜#8) 完了後に、**6/1 リリースの必須スコープ**として追加実装する PR を集約する。

**前提**: T-03 提案エンジン v2 (PR #1〜#8) は完了。本ドキュメントはその後続作業のみを扱う。

関連: [SUGGESTION_ENGINE_PLAN.md](./SUGGESTION_ENGINE_PLAN.md) / [ROLE_REFACTORING_PLAN.md](./ROLE_REFACTORING_PLAN.md) / [T-03_RELEASE_NOTES.md](../operations/T-03_RELEASE_NOTES.md)

---

## 全体像

**最優先: 提案機能関連 (PR-X5 + PR-X6)** — サービスの核心機能。本日着手分から先頭に置く。

| 順序 | PR | 内容 | 工数 | 依存 |
|---|---|---|---|---|
| 1 | **PR-X5** | シードデータ拡充 + 既存 embedding backfill (生成済 JSON 同梱) | 1.5 日 | (なし、最優先で着手) |
| 2 | **PR-X6** | 提案 UI を段階表示 (Tiered) に変更 + 閾値撤廃 | 2-3 日 | PR-X5 (backfill 後の embedding でテスト) |
| 3 | **PR-X1** | super_admin role + 管理テナント seed + 認可ヘルパ | 1-2 日 | (なし、PR-X5/X6 と並行可) |
| 4 | **PR-X2** | super_admin ダッシュボード UI (Phase 1) | 2-3 日 | PR-X1 |
| 5 | **PR-X4** | テナント管理者プラン変更 UI (`/settings` にタブ追加) | 2-3 日 | PR-X1 (認可ヘルパ流用) |
| 6 | **PR-X3** | UI 文言更新 + ドキュメント整合 | 1 日 | PR-X1〜X6 |

**合計**: 9.5-13.5 日

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

#### 5-6. 検証 (基本)

- 単体テスト追加: サンプルプロジェクトが各リスト view から除外されること
- 単体テスト追加: 提案エンジンではサンプルプロジェクトの issues/retros が候補に含まれること
- 統合テスト: seedTenant() が sample projects も含めて clone すること
- 視覚回帰: 提案モーダルでサンプル候補が表示されることを確認

#### 5-7. 既存データへの embedding pre-generation (本日追加)

##### 背景

提案機能は embedding 軸が主軸 (重み 0.5) だが、`Knowledge.contentEmbedding` 等は
**新規作成 / 更新時にしか生成されない**。既存データ (本番にすでに存在する 60+ 件)
は永久に NULL のまま = 縮退モード (タグ + pg_trgm のみ) で運用される。

このため、既存データに対して 1 回だけ embedding をまとめて生成する仕組みが必要。
ただし環境変数 (`VOYAGE_API_KEY`) を持つ開発者環境でしか実行できないため、
**生成済み embedding を JSON にコミットしておき、deploy 時に DB へ流し込む** 設計を取る。

##### 実装構成

```
prisma/
├─ seed-suggestion.ts                     # 既存 (拡充 + JSON 読込ロジック追加)
├─ seed-suggestion-embeddings.json        # 新規 (生成済 embedding をリポジトリにコミット)
scripts/
└─ generate-seed-embeddings.ts            # 新規 (開発者環境で 1 回実行)
package.json:
  "seed:generate-embeddings": "tsx scripts/generate-seed-embeddings.ts"
```

##### JSON 構造

```json
{
  "knowledges": {
    "<title-sha256-prefix>": [0.012, -0.453, ...]
  },
  "issues": {
    "<title-sha256-prefix>": [0.234, 0.567, ...]
  },
  "retrospectives": {
    "<conducted-date+project-name-sha256-prefix>": [-0.123, 0.456, ...]
  }
}
```

key は **シードデータの安定識別子** (title 等の SHA-256 先頭 16 文字) を使う。
これにより、シード内容を後から修正しても同じ key で対応する embedding を
解決できる (修正が大きい場合は再生成が必要)。

##### 既存 (本番に手動投入済) データの backfill

シード新規投入分は seed スクリプトが自動で JSON から読み込んで適用するが、
**既に本番に存在する `PowerPlatform とは` 等のユーザ追加分** に対しては:

1. **オプション A**: 開発者が `pnpm seed:generate-embeddings --backfill-existing` で
   全件の embedding を Voyage API 経由で生成して直接 DB に書き込む (本番 DB に対して実行、
   一度きり、所要時間 数分、Voyage 月次無料枠 200M token 内に十分収まる)
2. **オプション B**: 各データを手で 1 回開いて「保存」→ embedding 自動生成

オプション A を推奨 (手作業ゼロ)。

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

## PR-X6: 提案 UI を段階表示 (Tiered) に変更 + 閾値撤廃 (2-3 日)

**追加日**: 2026-05-07
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

スコアリング式 (タグ 0.3 + pg_trgm 0.2 + embedding 0.5) は **変更しない** (デグレ防止)。

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
- [ ] 既存テスト全件 PASS + 新規テスト追加
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

- [ ] PR-X5: シードナレッジ拡充 30 件 + サンプル課題 10-15 件 + サンプル振り返り 5-7 件 + 隠蔽機構 + 生成済 embedding 同梱 + 既存データ backfill
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
    1. PR-X5 (シードデータ拡充 + embedding backfill 1.5 日)
       完了見込: 2026-05-08 中
    2. PR-X6 (段階表示 UI + 閾値撤廃 2-3 日)  ← PR-X5 完了後
       完了見込: 2026-05-11 〜 12

  並行トラック (ロール再構築):
    3. PR-X1 (super_admin schema + 認可 1-2 日)  ← PR-X5 と同時着手可能
       完了見込: 2026-05-08 〜 09
    4. PR-X2 (super_admin ダッシュボード 2-3 日)  ← PR-X1 完了後
    5. PR-X4 (テナント管理者プラン変更 UI 2-3 日)  ← PR-X1 完了後
       PR-X2 と PR-X4 は並行可

  最後:
    6. PR-X3 (UI 文言 + ドキュメント 1 日)  ← 全 PR 完了後
       完了見込: 2026-05-17 〜 2026-05-20
```

**PR-X5/X6 を提案機能トラックとして最優先扱い** とする。理由は本ドキュメント冒頭
「優先順位の根拠」を参照。

PR-X4 と PR-X5 を同時着手しないこと (PR-X4 は admin 認可ヘルパに依存)。
PR-X1 と PR-X5 は依存ゼロで並行着手可能。

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
