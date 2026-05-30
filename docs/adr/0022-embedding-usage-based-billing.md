# ADR-0022: Embedding 機能の従量課金 — Expert/Pro ¥1/call (2026-06-01)

> ⚠️ **単価改定済 (2026-05-30)**: Expert/Pro の Embedding 単価は [ADR-0029](./0029-embedding-price-revision-5jpy.md) で **¥1 → ¥5/call** に改定されました。本 ADR の単価記述 (¥1) は**導入時の歴史的記録**として残します。現行単価・課金構造の真実源は [src/config/embedding-pricing.ts](../../src/config/embedding-pricing.ts) と ADR-0029 を参照してください。課金対象 featureUnit / Beginner ¥0 / backfill 無料 は本 ADR のまま有効です。

> ⚠️ **上限ロジック改定済 (2026-05-30)**: 「Embedding は monthlyBudgetCap 判定対象外」「Beginner Embedding 月次上限なし」は [ADR-0030](./0030-embedding-monthly-budget-cap.md) で部分上書きされました。Expert/Pro は新カラム `monthlyEmbeddingBudgetCapJpy` で個別予算上限を任意設定可能、Beginner は月 100 件の試用上限が新設されています。Fair Use Limit (10,000 件) は safety net として残置。

> ✅ **credit_card 払い有効化済 (2026-05-30)**: 採択時 (2026-06-01 リリース予定) は「リリース時は credit_card 払い未対応 → 将来 Stripe 有効化」を前提とした **Stripe-ready 設計** でした。その後 PR #469 で credit_card UI が解禁され、Sandbox→Live mode 移行 (TC-L1〜L8 PASS) が 2026-05-30 に完遂したため、**6/1 リリース時点で credit_card 払いは有効** です。本文中の「リリース時 未対応 / 将来 Stripe 有効化時」記述は **歴史的記録** として残します。実際には 6/1 launch から credit_card テナントへ 5 Item invariant (Haiku/Sonnet/Embedding/DBCap/Storage) で Subscription が組成され、Stripe Invoice に embedding 課金が反映されます (= `feedback_billing_invariant` 完全成立)。

- **Status**: Accepted (2026-06-01) / **単価のみ ADR-0029 で改定 (2026-05-30)** / **credit_card 6/1 launch で有効化済 (2026-05-30)**
- **Date**: 2026-06-01
- **Deciders**: teppei
- **Supersedes (partial)**: [ADR-0019](./0019-billable-feature-units-and-free-tier-expansion.md) (Embedding 無料化 → Expert/Pro のみ ¥1 課金、Fair Use Limit は Beginner 専用に縮小)
- **Based on**: [ADR-0020](./0020-db-capacity-usage-based-billing.md) (DB 容量従量課金) / [ADR-0021](./0021-file-storage-usage-based-billing.md) (ファイル添付従量課金) の Stripe Meter Event 経路を流用

---

## Context

### 現状 (= ADR-0019 / 2026-05-24 〜 本 ADR 採用直前)

ADR-0019 で Embedding 系 featureUnit (= Knowledge / RiskIssue / Retrospective / Memo / 添付ファイル / チャット検索 / CSV インポート / 月初 backfill cron) を **全プラン無料・無制限** とした。背景は:

- Voyage AI voyage-4-lite は ¥0.036 / call (= LLM の 1/50〜1/150 の実コスト)
- Voyage 200M tokens/月の無料枠 (= アカウント単位、全テナント共有) で実コスト ¥0 運用可
- 「資産入力・チャット検索が完全無料」訴求 (LP / api-usage-guide.md §1) で Beginner ユーザの新規獲得を狙う

無料 featureUnit の暴走 (= 1 テナントが Voyage 無料枠を食い潰す) は `fair-use-limit.service` (= 月 10,000 calls/tenant の hard limit) で防御していた。

### 課題

1. **「課金経路を最初から仕込んでおきたい」要件**: ~~2026-06-01 リリースでクレジットカード払いは未対応だが、将来 Stripe 有効化時にコード変更ゼロで動き出す~~ **Stripe-ready 設計** にしたい。これは Embedding 課金経路が無いと部分的にしか実現できない。 *(2026-05-30 追記: PR #469 で credit_card UI 解禁 + Sandbox→Live 移行完了。launch 時点で credit_card 有効、Embedding 含む 5 Item Subscription で稼働)*
2. **収益化の機会損失**: Expert/Pro プランで 1000 件/月の embedding 利用があっても収益 ¥0。Voyage 実コスト ¥36/月 は事業者が負担する一方、Beginner 50 件上限 (¥500/月 上限) の Expert/Pro 移行誘因が弱い。
3. **Fair Use Limit の意義縮小**: 「無料 featureUnit のみ適用」設計のため、Expert/Pro テナントが Voyage 枠を食い潰しても止められない (= cost=0 で budget cap 不発火)。

### 制約 (本 ADR の前提)

- **Beginner 「90 日完全無料」訴求は絶対保全**: LP line 20/251/768/773 + api-usage-guide.md §1 で謳う「資産入力・チャット検索すべて無料」が崩れると消費者契約法/景品表示法リスク + Beginner→Expert/Pro アップセル動線の根幹崩壊。
- ~~**2026-06-01 リリースでクレジットカード払い未対応**: Stripe 設定 (Dashboard / env) は実施せず、invoice / bank_transfer 払い経路のみで運用。~~ *(2026-05-30 更新: PR #469 で credit_card UI 解禁 + Sandbox→Live 移行完了。Stripe Dashboard 5 Price + Webhook + Production env 全設定済。launch 時点で invoice / credit_card の二経路稼働)*
- **既存 Beginner 50 件上限 + monthlyBudgetCap の動作不変**: Embedding を上限カウントに含めると「資産入力 200 件 + チャット検索 100 回」で枠枯渇しユーザ操作を止める事故になる。
- **不当請求 (= ユーザ非起動の処理で請求発生) は厳禁**: 月初 cron による embedding-backfill (= 失敗した embedding を月初に自動再生成) はユーザ起動ではないため、課金すると「自分が起こした覚えのない処理での請求」と感じられ UX/信頼関係に直接影響する。

---

## Decision

### 1. 課金パラメータ

| 項目 | 値 | 根拠 |
|---|---|---|
| **対象 featureUnit** | knowledge-embedding / risk-issue-embedding / retrospective-embedding / memo-embedding / chat-semantic-search / external-import-embedding / attachment-embedding (= **7 種**) | 全てユーザ起動の Embedding 操作 |
| **Beginner 単価** | **¥0 / call (無料維持)** | 「90 日完全無料」訴求の絶対保全 |
| **Expert 単価** | **¥1 / call** | Voyage 実コスト ¥0.036 の約 27 倍 = 事業者の Voyage 枠保護 + ユーザの「無料感覚で使える」価格帯 |
| **Pro 単価** | **¥1 / call** | Embedding は plan 間で品質差ゼロ (= 同一 Voyage モデル) のため Expert と同価 |
| **bulk 課金単位** | **1 業務操作 = 1 ApiCallLog = ¥1** | CSV 一括取込 100 件でも ¥1 (= `generateBatchEmbeddings` の集約構造、feedback_bulk_llm_call_unit) |
| **backfill (cron 自動リカバリ)** | **全プラン ¥0 維持** | 不当請求リスク回避、UX/信頼関係保護 |
| **計測単位** | per-call (= ApiCallLog 1 件単位) | LLM 系と整合 |
| **Beginner 月次上限への計上** | **しない** | 既存 50 件上限ロジック不変、資産入力で枠枯渇しない |
| **monthlyBudgetCap 判定対象** | **しない (本 ADR 時点)** → **[ADR-0030](./0030-embedding-monthly-budget-cap.md) で個別 `monthlyEmbeddingBudgetCapJpy` を新設し判定対象化** | 本 ADR 時点は「Embedding は必須機能のため予算上限とは独立」だが、ADR-0026 非同期化 + 月初 backfill cron + 既存 embedding 継続利用の多層フォールバックが成立した後、ユーザ予算管理の手段を提供 |
| **Beginner Embedding 月次上限** | **なし (本 ADR 時点)** → **[ADR-0030](./0030-embedding-monthly-budget-cap.md) で 100 件/月の試用上限を新設** | 本 ADR 時点は Voyage 無料枠保護を Fair Use Limit (10,000 件) のみで担保していたが、ユーザ向け試用範囲の明示として ADR-0030 で 100 件を上書き |

### 2. 重要設計判断

#### 2.1 Backfill は明示的 free (= EMBEDDING_BACKFILL_FEATURE_UNITS を別配列で定義)

**問題**: `*-embedding-backfill` は月初 cron が失敗した embedding を自動再生成する処理。1000 件の embedding が失敗していた場合、cron で 1000 件再生成すると「課金対象 featureUnit」として ¥1000 になる。これは「自分が起こした覚えのない処理での請求」 = **不当請求**。

**対処**: `billing-feature-units.ts` で `EMBEDDING_BILLABLE_FEATURE_UNITS` (= 7 種ユーザ起動) と `EMBEDDING_BACKFILL_FEATURE_UNITS` (= 5 種 cron 自動) を別配列で定義し、`withMeteredLLM` が backfill を判定した時点で `cost=0` 固定にする。`BILLABLE_FEATURE_UNITS` の union にも backfill は含めない (= billing-aggregation / api-usage-recalc いずれも対象外)。

**判定階層**:

| 階層 | 配列 | cost | counter | Stripe queue |
|---|---|---|---|---|
| LLM_BILLABLE | project-upsert / suggestion-explanation / auto-tag-extract | `resolveCostForPlan(plan)` | currentMonthApi* | haiku/sonnet event |
| **EMBEDDING_BILLABLE** | knowledge / risk-issue / retrospective / memo / chat / external-import / attachment | **`resolveEmbeddingCostJpy(plan)`** | **currentMonthEmbedding*** | **embedding event (cost > 0 のみ)** |
| STORAGE_OVERAGE | db-capacity-overage / storage-file-overage | 月初 cron で算出 | (= 直接 INSERT) | db-overage / storage-overage event |
| **EMBEDDING_BACKFILL** | **5 種 backfill** | **0 (明示)** | **不変** | **不投入** |

#### 2.2 Beginner 50 件上限 + monthlyBudgetCap は LLM 系のみ判定 (= 既存ロジック不変)

`withMeteredLLM` の Step 3 (Beginner 50 件) と Step 4 (budget cap) は `isLlmBillableFeatureUnit(featureUnit)` のときのみ実行する。Embedding が判定対象外のため、Beginner ユーザがチャット検索/資産入力で枠枯渇する事故は発生しない。

#### 2.3 Fair Use Limit は Beginner プラン専用に縮小維持

ADR-0019 の Fair Use Limit (= 月 10,000 calls/tenant の hard limit) は「無料 featureUnit が cost=0 で budget cap 不発火」問題への対策だった。本 ADR で Expert/Pro の Embedding が cost=¥1 になることで、Expert/Pro は budget cap で自然防御される。一方 Beginner は依然 cost=0 のため、Beginner プランの 5 席 × 90 日試用期間内に Voyage 枠を食い潰すリスクがある (= 理論値 4,500,000 calls)。

**対処**: `fair-use-limit.service.ts` の `checkFairUseLimit` を `plan === 'beginner'` のときのみ適用させる。`metered.ts` Step 3.5 も同様に Beginner 限定の条件に絞る。閾値 10,000 calls/月 はそのまま。`degraded-error-messages.ts` の `fair_use_limit_exceeded` メッセージは保持 (Beginner ユーザに表示)。

#### 2.4 Counter は独立カラム (currentMonthEmbedding*) で管理

Embedding 件数/課金額は新規カラム `Tenant.currentMonthEmbeddingCallCount` / `currentMonthEmbeddingCostJpy` で管理する。理由:

- LLM 系 counter (currentMonthApi*) は Beginner 50 件上限 + monthlyBudgetCap 判定対象。Embedding を加算すると上限ロジックが壊れる。
- 表示で「LLM 利用料 / Embedding 利用料 / ストレージ超過」を 3 セクション分離するため、データソースも分離した方が UX が明快。
- Beginner も件数記録 (cost=0 だが count は increment)。UI で「Embedding 200 件 / ¥0 (無料利用中)」と表示可能。

#### 2.5 Stripe-ready 設計 (= 2026-05-30 credit_card 有効化完了、Embedding Item 稼働中)

> ✅ **2026-05-30 更新**: ADR 採択時 (2026-06-01 想定) は「リリース時は credit_card 未対応 → 将来 Stripe 有効化」の Stripe-ready 設計でしたが、PR #469 + Sandbox→Live 移行 (TC-L1〜L8 PASS) で **launch 時点から credit_card 有効** に変更。`STRIPE_PRICE_EMBEDDING` Production も設定済みで、5 Item Subscription (Haiku/Sonnet/Embedding/DBCap/Storage) で稼働中。

`STRIPE_PRICE_EMBEDDING` 環境変数は **optional** な Stripe-ready 設計を維持:

- **未設定** (= 採択時想定 / Sandbox 等の補助環境): `getStripePriceConfig()` は throw せず embedding=undefined を返す。`createSubscriptionForTenant` は Embedding Item を Subscription に追加しない (= 4 本構成)。`stripe-usage-flush` は embedding queue を見ず空 queue 扱い。
- **設定済み** (= ✅ Production 2026-05-30 以降): Subscription Item 5 本目として追加、queue 送信稼働中。env 設定だけで動作 (= コード変更ゼロの Stripe-ready 設計を維持)。

新 Meter event 名 `tasukiba_embedding_call` を `STRIPE_METER_EVENT_NAMES.embedding` で定義。Stripe Dashboard で Meter + Price ([ADR-0029](./0029-embedding-price-revision-5jpy.md) で ¥1 → ¥5 改定済、Metered) 作成 + Netlify env 設定の運用作業を `docs/operations/STRIPE_SETUP.md` に記載。

### 3. 請求 invariant (= 5 経路一致の絶対要件)

[memory feedback_billing_invariant.md](../../memory/) 遵拠。Embedding 課金額は以下 5 経路で完全一致しなければならない:

1. **ApiCallLog.costJpy SUM (= 真値)**: featureUnit ∈ EMBEDDING_BILLABLE_FEATURE_UNITS の SUM
2. **Tenant.currentMonthEmbeddingCostJpy (= キャッシュ counter)**: withMeteredLLM がリアルタイム increment
3. **画面表示 (= テナント設定 + super_admin ダッシュボード)**: ApiCallLog SUM ベース (= 真値、counter キャッシュではない)
4. **CSV エクスポート (= 月次請求業務)**: ApiCallLog SUM ベース
5. **請求書 (= invoice/bank_transfer)**: `billing-aggregation.service` が ApiCallLog SUM (featureUnit ∈ BILLABLE_FEATURE_UNITS) で集計、自動的に Embedding 分も含まれる

✅ 2026-05-30 以降は 6 経路目に **Stripe Meter Event 送信量** が加わっており (= apiCallLogId を identifier に重複送信防止)、credit_card テナントへの請求書 (Stripe Invoice) もこの SUM と一致する 6 経路 invariant が稼働中。

---

## Consequences

### Positive

- **収益化の起点**: Expert/Pro プランで Embedding 課金が立つ (= 月 1000 件で ¥1000 売上、Voyage 実コスト ¥36 を大きく上回る)
- **Beginner 訴求保全**: 「90 日完全無料」「資産入力・チャット検索すべて無料」訴求が完全に成立
- **Stripe-ready**: ~~将来~~ Stripe Dashboard 作業 + env 設定だけでクレジットカード払いが動く設計 *(2026-05-30 達成済: PR #469 + Sandbox→Live 移行完了で実稼働)*
- **invariant 強化**: Embedding を ApiCallLog ベース集計に乗せたことで、5 経路 (将来 6 経路) の一致監視が明確化
- **不当請求リスク回避**: backfill 明示 free + Beginner 上限/budget cap 不変で UX/信頼関係を保護
- **Fair Use Limit の意義回復**: Beginner 専用に縮小することで dead code 化を回避、Voyage 無料枠を引き続き防御

### Negative

- **schema migration コスト**: Tenant + TenantMonthlyUsageHistory に 5 列追加 (= migration `20260601_embedding_billing`)
- **既存テスト書換え**: 旧仕様で「Embedding cost=0」を期待する metered.test.ts / 各 service test を Expert/Pro × Embedding featureUnit のテストケースで書換える必要がある
- **ドキュメント書換え**: api-usage-guide.md / plan-guide.md / business / design / operations / HomePage LP の料金記述を一括書換え
- **告知ルール**: api-usage-guide.md §5.3 「単価変更 30 日前告知」ルール対象。リリース前着手 (2026-06-01 前 / 顧客ゼロ) なら告知不要、リリース後着手なら Expert/Pro 新規契約規約に最初から記載で代替可能。 *(2026-05-30 補足: 採択時点で credit_card 払いも有効化済となったため、6/1 launch 前の Stripe Dashboard + env 設定を含めて「告知不要」期間内に完遂。ADR-0029 ¥1→¥5 改定も同 launch 前で告知対象外)*

### Neutral

- ~~リリース時はクレジットカード払い未対応のため~~ Embedding 課金は invoice 経路では `billing-aggregation.service` で月次請求書に乗り、credit_card 経路では Stripe Meter Event 経由で Stripe Invoice に反映される。 *(2026-05-30 更新: credit_card 払いも有効化済、双方経路稼働中)*
- Beginner は cost=0 のため counter は increment するが Stripe queue は不投入 (= 件数記録のみ、課金経路には乗らない)。

---

## 単価変更履歴

本 ADR は [api-usage-guide.md §5.3](../public/api-usage-guide.md) の単価変更履歴に以下の行を追加する:

| 改定日 | ADR | 主な変更 |
|---|---|---|
| 2026-06-01 | [ADR-0022](./0022-embedding-usage-based-billing.md) | **Embedding 機能の従量課金導入** (Expert/Pro ¥1/call、Beginner 無料維持) / Fair Use Limit を Beginner 専用に縮小 / Stripe-ready 設計 |

---

## 効力発生日ルール

[api-usage-guide.md §5.3](../public/api-usage-guide.md) の「将来の単価変更も、**効力発生日の 30 日以上前** にメール + ユーザ規約への掲示でお知らせします」ルール対象。

- **リリース前着手 (2026-06-01 前 / Expert/Pro 既存顧客ゼロ)**: 告知不要
- **リリース後着手**: 新規 Expert/Pro 契約規約に最初から「Embedding ¥5/call」(ADR-0029 改定後) を記載することで告知代替可能。既存 Expert/Pro 契約者がいる場合は規約改定 + 30 日前メール告知 + サービス内バナー掲示が必要 *(2026-05-30 実績: 6/1 launch 前に着手 + 完了したため告知不要パスを満たす。credit_card 払いも同 launch から有効化済)*
- **Beginner ユーザ**: 影響なし (= 無料維持) のため告知不要

---

## 関連リソース

- [migration: 20260601_embedding_billing](../../prisma/migrations/20260601_embedding_billing/migration.sql)
- [src/config/billing-feature-units.ts](../../src/config/billing-feature-units.ts) (4 階層 + 判定関数)
- [src/config/embedding-pricing.ts](../../src/config/embedding-pricing.ts) (plan 別単価)
- [src/lib/stripe.ts](../../src/lib/stripe.ts) (STRIPE_METER_EVENT_NAMES.embedding / STRIPE_PRICE_EMBEDDING optional)
- [src/lib/llm/metered.ts](../../src/lib/llm/metered.ts) (cost 分岐 / counter 分離 / Stripe queue 分岐)
- [src/services/fair-use-limit.service.ts](../../src/services/fair-use-limit.service.ts) (Beginner 限定に縮小)
- [src/services/billing-aggregation.service.ts](../../src/services/billing-aggregation.service.ts) (BILLABLE_FEATURE_UNITS 自動取込)
- [docs/operations/ENV_VARS.md](../operations/ENV_VARS.md) (STRIPE_PRICE_EMBEDDING optional)
- [docs/public/api-usage-guide.md](../public/api-usage-guide.md) (公開料金ガイド)
- [HomePage tasukiba-user.md](../../../HomePage/src/content/product/ja/tasukiba-user.md) (LP 料金表)
- Memory: [feedback_billing_invariant.md](../../memory/), [feedback_bulk_llm_call_unit.md](../../memory/), [feedback_client_service_boundary.md](../../memory/), [feedback_3layer_sync_filter.md](../../memory/), [feedback_drift_detection_design.md](../../memory/)
