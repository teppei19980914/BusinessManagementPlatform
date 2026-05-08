-- P-5b (2026-05-08): TenantMonthlyUsageHistory テーブルを追加
--
-- 目的:
--   月初リセット cron が Tenant.currentMonthApiCallCount / currentMonthApiCostJpy を
--   0 にリセットする直前のスナップショットを yearMonth (= リセット対象月の前月) で
--   永続化する。super_admin の使用量履歴グラフ + CSV エクスポート + 請求書生成 (P-7)
--   の正本データになる。
--
-- 詳細仕様: docs/roadmap/V1_FINAL_TASKS.md P-5
-- 関連: src/services/tenant-monthly-reset.service.ts (snapshot 生成)
--       src/services/super-admin.service.ts (履歴取得)

CREATE TABLE "tenant_monthly_usage_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "year_month" VARCHAR(7) NOT NULL,
    "api_call_count" INTEGER NOT NULL,
    "api_cost_jpy" INTEGER NOT NULL,
    "plan" VARCHAR(20) NOT NULL,
    "active_user_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "tenant_monthly_usage_history_pkey" PRIMARY KEY ("id")
);

-- 月次 cron の冪等性保証 (二重実行で行が重複しない)
CREATE UNIQUE INDEX "uq_tenant_monthly_usage_history"
  ON "tenant_monthly_usage_history" ("tenant_id", "year_month");

-- 全テナント横断の特定月集計を高速化 (履歴グラフ・CSV エクスポート用)
CREATE INDEX "idx_monthly_usage_year_month"
  ON "tenant_monthly_usage_history" ("year_month");

-- 外部キー制約
ALTER TABLE "tenant_monthly_usage_history"
  ADD CONSTRAINT "tenant_monthly_usage_history_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE NO ACTION ON UPDATE CASCADE;
