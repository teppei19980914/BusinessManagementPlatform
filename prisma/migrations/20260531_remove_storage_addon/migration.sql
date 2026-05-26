-- chore/storage-addon-backend-removal (2026-05-26):
--   ADR-0020 (DB 容量従量課金) + ADR-0021 (添付ファイル従量課金) で完全従量課金化されたため、
--   旧 4 段階プラン (Standard/Plus/Pro/Enterprise) 関連の以下カラムを撤去。
--
-- 撤去カラム:
--   tenants.storage_addon_plan
--   tenants.storage_grace_period_started_at
--   tenants.scheduled_storage_addon_at
--   tenants.scheduled_next_storage_addon
--   tenants.stripe_subscription_item_storage_id
--   tenant_monthly_usage_history.storage_addon_plan
--   tenant_monthly_usage_history.storage_addon_jpy

ALTER TABLE "tenants" DROP COLUMN IF EXISTS "storage_addon_plan";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "storage_grace_period_started_at";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "scheduled_storage_addon_at";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "scheduled_next_storage_addon";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "stripe_subscription_item_storage_id";

ALTER TABLE "tenant_monthly_usage_history" DROP COLUMN IF EXISTS "storage_addon_plan";
ALTER TABLE "tenant_monthly_usage_history" DROP COLUMN IF EXISTS "storage_addon_jpy";
