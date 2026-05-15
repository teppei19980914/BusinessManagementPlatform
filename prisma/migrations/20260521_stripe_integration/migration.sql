-- Stripe Metered Billing 連携 (PR-S1 / 2026-05-14)
--
-- 関連:
--   - 仕様: docs/business/STRIPE_BILLING.md
--   - 詳細技術設計: docs/design/STRIPE_TECHNICAL_DESIGN.md
--   - 設計判断: docs/adr/0006-stripe-metered-billing-integration.md
--   - 実装計画: docs/roadmap/STRIPE_INTEGRATION_PLAN.md
--
-- 影響:
--   - 全カラム NULLABLE (= 既存テナントは Stripe 未連携状態で開始、`invoice` 払い継続)
--   - 新規 3 テーブルは独立 (= 既存業務データへの影響ゼロ)
--   - backfill 不要、ダウンタイムなし
--   - feature flag (STRIPE_ENABLED 環境変数) により、PR-S5 マージ後も UI レベルで有効化制御
--
-- ロールバック手順:
--   ALTER TABLE tenants DROP COLUMN stripe_customer_id, stripe_subscription_id, ...;
--   DROP TABLE stripe_webhook_events, billing_history, stripe_usage_record_queue;
--   (順序は逆: 子テーブル → 親テーブルカラム)

-- ============================================================
-- 1. tenants テーブルへの Stripe 連携カラム追加
-- ============================================================
ALTER TABLE "tenants"
  ADD COLUMN "stripe_customer_id"                  VARCHAR(50),
  ADD COLUMN "stripe_subscription_id"              VARCHAR(50),
  ADD COLUMN "stripe_subscription_status"          VARCHAR(30),
  ADD COLUMN "stripe_subscription_item_haiku_id"   VARCHAR(50),
  ADD COLUMN "stripe_subscription_item_sonnet_id"  VARCHAR(50),
  ADD COLUMN "stripe_subscription_item_storage_id" VARCHAR(50),
  ADD COLUMN "stripe_default_payment_method_id"    VARCHAR(50),
  ADD COLUMN "card_last_verified_at"               TIMESTAMPTZ,
  ADD COLUMN "card_verification_status"            VARCHAR(20),
  ADD COLUMN "auto_suspend_scheduled_at"           TIMESTAMPTZ;

-- 1 テナント = 1 Customer / 1 Subscription の UNIQUE 制約
ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_stripe_customer_id_key" UNIQUE ("stripe_customer_id"),
  ADD CONSTRAINT "tenants_stripe_subscription_id_key" UNIQUE ("stripe_subscription_id");

-- credit_card テナントの抽出用インデックス (= active Subscription を絞り込む照合 cron で使用)
CREATE INDEX "idx_tenants_stripe_subscription_status"
  ON "tenants" ("stripe_subscription_status");

-- ============================================================
-- 2. stripe_webhook_events テーブル新規作成 (= 冪等性 + DLQ)
-- ============================================================
CREATE TABLE "stripe_webhook_events" (
  "id"            VARCHAR(50)  PRIMARY KEY,         -- = Stripe event.id
  "type"          VARCHAR(60)  NOT NULL,
  "payload_json"  JSONB        NOT NULL,
  "received_at"   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at"  TIMESTAMPTZ,
  "error_message" TEXT,
  "retry_count"   INTEGER      NOT NULL DEFAULT 0,
  "next_retry_at" TIMESTAMPTZ
);

CREATE INDEX "idx_stripe_webhook_events_type"
  ON "stripe_webhook_events" ("type");

-- 再試行候補抽出用 (processedAt が null かつ nextRetryAt が今より前)
CREATE INDEX "idx_stripe_webhook_events_retry_candidates"
  ON "stripe_webhook_events" ("processed_at", "next_retry_at");

-- ============================================================
-- 3. billing_history テーブル新規作成 (= invoice / bank_transfer / credit_card 統一管理)
-- ============================================================
CREATE TABLE "billing_history" (
  "id"                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"         UUID         NOT NULL,
  "year_month"        VARCHAR(7)   NOT NULL,
  "payment_method"    VARCHAR(20)  NOT NULL,
  "amount_jpy"        INTEGER      NOT NULL,
  "tax_amount_jpy"    INTEGER      NOT NULL,
  "total_amount_jpy"  INTEGER      NOT NULL,
  "status"            VARCHAR(20)  NOT NULL,
  "stripe_invoice_id" VARCHAR(50),
  "paid_at"           TIMESTAMPTZ,
  "failure_reason"    VARCHAR(50),
  "retry_count"       INTEGER      NOT NULL DEFAULT 0,
  "created_at"        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "billing_history_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
);

CREATE UNIQUE INDEX "uq_billing_history_tenant_month"
  ON "billing_history" ("tenant_id", "year_month");

CREATE INDEX "idx_billing_history_status"
  ON "billing_history" ("status");

CREATE INDEX "idx_billing_history_stripe_invoice"
  ON "billing_history" ("stripe_invoice_id");

-- ============================================================
-- 4. stripe_usage_record_queue テーブル新規作成 (= Usage Record 非同期送信)
-- ============================================================
CREATE TABLE "stripe_usage_record_queue" (
  "id"               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"        UUID         NOT NULL,
  "call_type"        VARCHAR(20)  NOT NULL,         -- 'haiku' / 'sonnet'
  "api_call_log_id"  UUID         NOT NULL,         -- = idempotency_key
  "quantity"         INTEGER      NOT NULL DEFAULT 1,
  "occurred_at"      TIMESTAMPTZ  NOT NULL,
  "retry_count"      INTEGER      NOT NULL DEFAULT 0,
  "next_send_at"     TIMESTAMPTZ,
  "sent_at"          TIMESTAMPTZ,
  "last_error"       TEXT,
  "created_at"       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stripe_usage_record_queue_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
);

-- 送信候補抽出用 (sentAt が null かつ nextSendAt が今より前)
CREATE INDEX "idx_stripe_usage_queue_pending"
  ON "stripe_usage_record_queue" ("sent_at", "next_send_at");

CREATE INDEX "idx_stripe_usage_queue_tenant"
  ON "stripe_usage_record_queue" ("tenant_id");
