-- 2026-05-26 ADR-0021 post-PR fullscan hardening (KDD §5.X+145, §5.X+146, §5.X+147, §5.X+148)
--
-- 1. storage_object_key の partial unique index
--    背景: 同 Pre-signed URL の concurrent finalize で重複 Attachment row が作成され
--    storageFileBytesUsed が二重計上される race を防ぐ (KDD §5.X+147)。
--    PostgreSQL の partial index: soft-deleted (deleted_at IS NOT NULL) 行は除外する
--    ことで、論理削除→再アップロードを許容しつつ active 行のみで unique 制約を発動。
--
-- 2. TenantMonthlyUsageHistory に file storage 列追加
--    背景: 既存 apiCostJpy に file storage が混入していると、UI / CSV で
--    「DB 容量超過なのか / ファイルストレージ超過なのか」の内訳が判別不能 (KDD §5.X+148)。
--    feedback_3layer_sync_filter: 3 レイヤ (current / cron snapshot / history) で
--    storage 関連フィルタを同期するため、history 側にも独立列を持たせる。
--
-- ============================================================
-- 1. Attachment.storage_object_key 部分 UNIQUE 制約 (concurrent finalize race 防止)
-- ============================================================
-- ※ Prisma の @unique は partial に未対応のため raw SQL で作成。
-- ※ NULL 値は重複許容 (= storage_provider='url' な行は NULL のまま並ぶ)。
-- ※ soft-delete 済 (deleted_at IS NOT NULL) 行は除外して、論理削除後の同一 key 再利用に対応。
CREATE UNIQUE INDEX IF NOT EXISTS "idx_attachments_storage_object_key_unique_active"
  ON "attachments" ("storage_object_key")
 WHERE "storage_object_key" IS NOT NULL
   AND "deleted_at" IS NULL;

-- ============================================================
-- 2. TenantMonthlyUsageHistory にファイルストレージ列追加
-- ============================================================
-- これにより past-month CSV / UI / super_admin ダッシュボードで
-- DB 容量と ファイルストレージ を独立に表示可能 (= 3 レイヤ同期完成形)。
--
-- 既存 row への影響:
--   - 既存月の history 行 (~2026-05) は file_storage_overage 課金が存在しないため
--     NULL のまま (= 0 として扱う)。明示的 backfill は不要。
--   - 2026-06 月初 cron から snapshot 時に値が入る。
ALTER TABLE "tenant_monthly_usage_history"
  ADD COLUMN IF NOT EXISTS "file_storage_bytes_peak"    BIGINT,
  ADD COLUMN IF NOT EXISTS "file_storage_overage_jpy"   INTEGER;

-- ============================================================
-- 影響:
--   - 既存運用: 影響なし (追加カラム + 部分 unique index のみ、既存行は変わらず)
--   - rollback 容易性: index DROP + ALTER TABLE DROP COLUMN で rollback 可能
-- ============================================================
--
-- Rollback SQL (本番 migration 失敗時に手動実行可):
--   DROP INDEX IF EXISTS "idx_attachments_storage_object_key_unique_active";
--   ALTER TABLE "tenant_monthly_usage_history"
--     DROP COLUMN IF EXISTS "file_storage_bytes_peak",
--     DROP COLUMN IF EXISTS "file_storage_overage_jpy";
--
-- 関連:
--   - ADR: docs/adr/0021-file-storage-usage-based-billing.md
--   - 前 migration: 20260526_file_storage_billing_and_embedding/migration.sql
--   - KDD: docs/knowledge/KDD_PATTERNS.md §5.X+145 / §5.X+147 / §5.X+148
