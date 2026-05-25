-- 2026-05-25 ADR-0020: DB 容量従量課金 — peak / drift / circuit breaker カラム追加
--
-- 背景:
--   - 旧 4 段階プラン (Standard 20MB / Plus 220MB / Pro 1.02GB / Enterprise 5.02GB) を
--     階段関数型従量課金 (50MB 無料 + 1GB tier × ¥50) に変更する (ADR-0020)
--   - 月中 peak (= max bytes during month) ベースで請求 → 月末削除→月初再投入の抜け道防止
--   - 既存 storage_bytes_used (= 現在値) はそのまま残し、peak 計測用カラムを追加
--
-- 追加カラム (Tenant):
--   1. storage_bytes_peak_this_month BIGINT NOT NULL DEFAULT 0
--      → 月中の最大使用量。毎月 1 日 cron でリセット = 現在の storage_bytes_used。
--        write 経由 (storage-guard.service) で MAX 更新される。課金根拠の真値。
--
--   2. storage_bytes_peak_at TIMESTAMPTZ NULL
--      → peak 到達時刻 (UI 表示 / audit 用)
--
--   3. db_instance_bytes_peak_this_month BIGINT NULL
--      → drift 検知用: pg_database_size の月中 peak。
--        Supabase 実請求対比に使用し、tenant peak SUM との乖離を super_admin alert
--        (feedback_drift_detection_design.md と整合)
--
--   4. db_capacity_warning_level VARCHAR(8) NOT NULL DEFAULT 'none'
--      → 4 層防御の現状 Level ('none' / 'l1' / 'l2' / 'l3')
--        月初 cron でリセット、通知 spam 防止に使用 (R12)
--
--   5. storage_guard_circuit_fail_count INTEGER NOT NULL DEFAULT 0
--      → R3 fail-close circuit breaker の連続失敗カウンタ。
--        3 回連続で write 拒否、成功時に 0 リセット。
--
--   6. storage_guard_circuit_opened_at TIMESTAMPTZ NULL
--      → circuit breaker open 時刻 (= 一時 write 全拒否状態)
--
-- 対象:
--   - 全テナント (v1 単一テナント運用のため default-tenant + management のみ)
--   - 既存テナントの初期値: storage_bytes_peak_this_month = 0、後続 write で更新
--     (= 移行月の初回 write 時に現在値に MAX 同期される)
--
-- 削除予定 (P9-cleanup、本 migration では実施しない):
--   - storage_addon_plan (旧 4 段階プラン)
--   - storage_grace_period_started_at (旧 Grace period 7 日ロジック)
--   - storage_over_limit_notice_sent_at
--   - scheduled_storage_addon_at / scheduled_next_storage_addon
--   → R4 でハードキャップに一本化、R19 でこれらを物理削除
--
-- 影響:
--   - 既存運用: 影響なし (追加カラムのみ、既存カラム未変更)
--   - rollback 容易性: 追加カラムを DROP するだけで rollback 可能
--
-- Rollback SQL (本番 migration 失敗時に手動実行可、A-2 3 回目検証で追記):
--   ALTER TABLE "tenants"
--     DROP COLUMN IF EXISTS "storage_bytes_peak_this_month",
--     DROP COLUMN IF EXISTS "storage_bytes_peak_at",
--     DROP COLUMN IF EXISTS "db_instance_bytes_peak_this_month",
--     DROP COLUMN IF EXISTS "db_capacity_warning_level",
--     DROP COLUMN IF EXISTS "storage_guard_circuit_fail_count",
--     DROP COLUMN IF EXISTS "storage_guard_circuit_opened_at";
--   -- その後 `prisma migrate resolve --rolled-back 20260525_db_capacity_peak_columns` で状態同期
--
-- 関連:
--   - ADR: docs/adr/0020-db-capacity-usage-based-billing.md
--   - config: src/config/db-capacity-pricing.ts (SI 単位定数 / 計算ヘルパ)
--   - 計測: src/services/storage-guard.service.ts (P3 で改修予定)
--   - 月初請求: src/services/tenant-monthly-reset.service.ts (P4 で改修予定)

ALTER TABLE "tenants"
  ADD COLUMN "storage_bytes_peak_this_month"     BIGINT      NOT NULL DEFAULT 0,
  ADD COLUMN "storage_bytes_peak_at"             TIMESTAMPTZ,
  ADD COLUMN "db_instance_bytes_peak_this_month" BIGINT,
  ADD COLUMN "db_capacity_warning_level"         VARCHAR(8)  NOT NULL DEFAULT 'none',
  ADD COLUMN "storage_guard_circuit_fail_count"  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN "storage_guard_circuit_opened_at"   TIMESTAMPTZ;

-- 既存テナントの peak を現在値に初期化 (= 移行月初回 cron の起点を整える)
-- これにより、移行月の peak は「現在値 from now on の MAX」となり、過去使用量の遡及課金を回避する
UPDATE "tenants"
   SET "storage_bytes_peak_this_month" = "storage_bytes_used",
       "storage_bytes_peak_at"         = NOW()
 WHERE "deleted_at" IS NULL;
