-- 2026-05-30 ADR-0020 / ADR-0021 補完: DB 容量 / ファイルストレージ Subscription Item を Stripe-ready 化
--
-- 背景:
--   ADR-0020 (DB 容量従量課金、2026-05-25) と ADR-0021 (ファイル添付ストレージ従量課金、2026-05-26) は
--   それぞれの月初 cron で ApiCallLog INSERT + Tenant.currentMonthApiCostJpy increment +
--   StripeUsageRecordQueue enqueue + Stripe Meter Event 送信 (`tasukiba_db_capacity_overage_jpy` /
--   `tasukiba_storage_file_overage_jpy`) を実装済み。
--
--   しかし、createSubscriptionForTenant では Haiku + Sonnet + (optional) Embedding しか Subscription
--   Item として追加されていなかった。Stripe Meter Event は Customer 単位で集約されるが、
--   Subscription Item に紐付かない Meter Event は Stripe Invoice に反映されない仕様のため、
--   credit_card 払いテナントは DB 容量超過 / ファイルストレージ超過分が **請求書に載らない**
--   状態だった (= invoice 払いと credit_card 払いで請求金額が乖離 = invariant 違反)。
--
-- 設計:
--   - ADR-0022 (Embedding) と同じ **Stripe-ready optional パターン** を採用。
--   - 新規 env 変数: STRIPE_PRICE_DB_CAPACITY_OVERAGE / STRIPE_PRICE_STORAGE_FILE_OVERAGE
--   - 未設定 → createSubscriptionForTenant は当該 Item を追加しない (= 旧挙動互換)。
--   - 設定済 → 新規 Subscription 作成時に 4-5 本目の Item として追加され、Stripe Meter Event が
--             該当 Item に集約されて Stripe Invoice に円整数 quantity が反映される
--             (= invoice 払いの BillingHistory と完全 invariant 一致)。
--
-- 対象:
--   - Tenant テーブル: Stripe Subscription Item ID (DB 容量 / ストレージファイル用) を 2 列追加。
--     リリース時点では credit_card 払い未対応のため常に NULL。将来 Stripe Live mode 有効化時に
--     env を設定すれば completeStripeSetup が自動的に値をセットする。
--
-- 影響:
--   - 全カラム NULLABLE のため既存データに影響なし。
--   - 既存のクレジットカード払いテナントが存在しないため後付け migration 不要 (6/1 ローンチは
--     credit OFF、本番 Live mode は 6/1 以降に有効化予定で新規 Subscription は新コードで作成)。
--
-- 関連:
--   - ADR-0020: docs/adr/0020-db-capacity-usage-based-billing.md (本 migration §Stripe Item 追記)
--   - ADR-0021: docs/adr/0021-file-storage-usage-based-billing.md (本 migration §Stripe Item 追記)
--   - 設計詳細: docs/design/STRIPE_TECHNICAL_DESIGN.md
--   - Memory: feedback_billing_invariant.md (4 点一致 invariant の根拠)

-- ============================================================
-- Tenant テーブル: Stripe Subscription Item ID 2 列追加
-- ============================================================

ALTER TABLE "tenants"
  ADD COLUMN "stripe_subscription_item_db_capacity_id" VARCHAR(50),
  ADD COLUMN "stripe_subscription_item_storage_file_id" VARCHAR(50);

-- ============================================================
-- 注: 本 migration は schema 拡張のみ。
--   - Stripe Dashboard 側の Meter / Price 作成は別作業 (docs/operations/STRIPE_SETUP.md §2 参照)。
--   - Netlify 環境変数 STRIPE_PRICE_DB_CAPACITY_OVERAGE / STRIPE_PRICE_STORAGE_FILE_OVERAGE の
--     設定は別作業 (docs/operations/ENV_VARS.md §Stripe 参照)。
--   - コード側の参照は src/lib/stripe.ts: getStripePriceConfig() の `dbCapacityOverage?` /
--     `storageFileOverage?` 取得 + src/services/stripe-billing.service.ts: createSubscriptionForTenant
--     の items.push() で本 PR で追加。
-- ============================================================
