-- Storage add-on Plan (Phase 2 / 2026-05-08)
--
-- 役割:
--   LLM プラン (beginner/expert/pro) と独立した容量プラン (standard/plus/pro_storage/enterprise) を
--   Tenant に追加する。Standard は無料 (LLM プランに連動)、それ以外は月額固定の追加課金。
--
-- 設計判断:
--   - storage_bytes_used は日次 cron で更新するキャッシュ値 (pg_column_size 集計の結果)。
--     リアルタイム更新は CRUD ごとに発火すると重い + 業務ロジックを汚染するため避ける。
--   - storage_grace_period_started_at は P-B (Beginner expiry) と同パターン。
--     上限超過検知時に NOW() をセット → 7 日経過で write 停止 (middleware が判定)。
--     上限内に戻れば NULL クリア (cron が判定)。
--   - scheduled_storage_addon_at / scheduled_next_storage_addon は P-X4 (LLM プラン変更) と同パターン。
--     アップグレードは即時、ダウングレードは翌月 1 日 UTC 適用。
--
-- 冪等性 (§5.59 規約):
--   全 ALTER TABLE は ADD COLUMN IF NOT EXISTS で冪等化。再 deploy 安全。
--
-- 関連:
--   - サービス: src/services/tenant-storage.service.ts
--   - 計画: docs/roadmap/V1_FINAL_TASKS.md (Storage add-on)
--   - 教訓: docs/developer-guide/REFERENCE.md §5.59 (migration 冪等化規約)

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "storage_addon_plan"               VARCHAR(20)  NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS "storage_bytes_used"               BIGINT       NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "storage_bytes_used_at"            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "storage_grace_period_started_at"  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "storage_over_limit_notice_sent_at" TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "scheduled_storage_addon_at"       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "scheduled_next_storage_addon"     VARCHAR(20);
