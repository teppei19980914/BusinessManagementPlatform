-- 2026-05-26 ADR-0021: ファイル添付ストレージ従量課金 + Attachment Embedding
--
-- 背景:
--   - これまで Attachment は外部 URL のみ保持していたが、Supabase Storage 本体保存に対応する
--   - 本体ファイル容量は月中 peak ベースで従量課金 (100MB 無料 + 1GB tier × ¥10、50GB hardcap)
--   - 同時にファイル本文の Voyage embedding を生成し、提案エンジン/チャット file scope 検索で使用
--
-- 設計方針:
--   - ADR-0020 (DB 容量) と同設計 (peak / 4 層防御 / drift) を mirror
--   - 既存 URL 型 Attachment は storage_provider='url' で残し、新規が 'supabase'
--   - Embedding は別 ApiCallLog (featureUnit='attachment-embedding'、costJpy=0、運営負担)
--
-- ============================================================
-- 1. Tenant: ファイルストレージ peak / drift / 4 層防御 カラム追加
-- ============================================================
-- カラム説明:
--   - storage_file_bytes_used: 現在の Supabase Storage 使用バイト数 (日次 cron で集計キャッシュ)
--   - storage_file_bytes_used_at: 最終更新時刻 (UI で「○分前」表示用)
--   - storage_file_bytes_peak_this_month: 月中の最大値 (= 課金根拠の真値)
--   - storage_file_bytes_peak_at: peak 到達時刻 (UI 表示 / audit 用)
--   - storage_bucket_bytes_peak_this_month: drift 検知用 bucket 実容量 peak
--   - file_storage_warning_level: 4 層防御 Level ('none'/'l1'/'l2'/'l3'、通知 spam 防止)
--   - storage_file_bytes_yesterday: 日次 anomaly baseline (24h 前 snapshot、+5GB/day で alert)
ALTER TABLE "tenants"
  ADD COLUMN "storage_file_bytes_used"               BIGINT       NOT NULL DEFAULT 0,
  ADD COLUMN "storage_file_bytes_used_at"            TIMESTAMPTZ,
  ADD COLUMN "storage_file_bytes_peak_this_month"    BIGINT       NOT NULL DEFAULT 0,
  ADD COLUMN "storage_file_bytes_peak_at"            TIMESTAMPTZ,
  ADD COLUMN "storage_bucket_bytes_peak_this_month"  BIGINT,
  ADD COLUMN "file_storage_warning_level"            VARCHAR(8)   NOT NULL DEFAULT 'none',
  ADD COLUMN "storage_file_bytes_yesterday"          BIGINT;

-- ============================================================
-- 2. Attachment: Supabase Storage + Embedding カラム追加
-- ============================================================
-- カラム説明:
--   - storage_provider: 'url' (既存 URL 型) / 'supabase' (本体保存)
--   - storage_object_key: Supabase Object Key (tenant prefix 強制、RLS 整合)
--   - size_bytes: ファイルサイズ (url 型は NULL)
--   - content_embedding: pgvector(1024) - Voyage embedding
--   - embedding_status: pending/generating/completed/failed/unsupported
--   - extracted_text_hash: SHA-256 (重複 embedding 防止 + 改ざん検知)
--   - embedding_generated_at: 監査 / ApiCallLog 突合
--   - embedding_retry_count + embedding_last_retry_at: 指数 backoff リトライ管理
ALTER TABLE "attachments"
  ADD COLUMN "storage_provider"        VARCHAR(20)    NOT NULL DEFAULT 'url',
  ADD COLUMN "storage_object_key"      VARCHAR(500),
  ADD COLUMN "size_bytes"              BIGINT,
  ADD COLUMN "content_embedding"       vector(1024),
  ADD COLUMN "embedding_status"        VARCHAR(20)    NOT NULL DEFAULT 'pending',
  ADD COLUMN "extracted_text_hash"     VARCHAR(64),
  ADD COLUMN "embedding_generated_at"  TIMESTAMPTZ,
  ADD COLUMN "embedding_retry_count"   INTEGER        NOT NULL DEFAULT 0,
  ADD COLUMN "embedding_last_retry_at" TIMESTAMPTZ;

-- ============================================================
-- 3. 既存 URL 型 Attachment の backfill
-- ============================================================
-- 既存 row はすべて URL のみ保持の旧形式。
--   - storage_provider = 'url' (DEFAULT で既にセット、明示更新は不要)
--   - embedding_status = 'unsupported' (URL のみで本文無いため embedding 対象外)
-- DEFAULT 'pending' のままだと cron が誤って embedding 生成を試みるため、
-- 'unsupported' へ明示的に backfill する。
UPDATE "attachments"
   SET "embedding_status" = 'unsupported'
 WHERE "storage_provider" = 'url'
   AND "deleted_at" IS NULL;

-- ============================================================
-- 4. インデックス追加
-- ============================================================
-- embedding cron で pending を高速 fetch するための部分インデックス
CREATE INDEX "idx_attachments_embedding_status"
  ON "attachments" ("embedding_status", "embedding_last_retry_at");

-- drift 検知 / bucket 集計の高速化用 (tenantId + provider + soft-delete)
CREATE INDEX "idx_attachments_tenant_provider"
  ON "attachments" ("tenant_id", "storage_provider", "deleted_at");

-- ============================================================
-- 影響:
--   - 既存運用: 影響なし (追加カラムのみ、既存カラム未変更、既存 URL 型は backfill で安全に分類)
--   - rollback 容易性: 追加カラム DROP + index DROP で rollback 可能
-- ============================================================
--
-- Rollback SQL (本番 migration 失敗時に手動実行可):
--   DROP INDEX IF EXISTS "idx_attachments_tenant_provider";
--   DROP INDEX IF EXISTS "idx_attachments_embedding_status";
--   ALTER TABLE "attachments"
--     DROP COLUMN IF EXISTS "storage_provider",
--     DROP COLUMN IF EXISTS "storage_object_key",
--     DROP COLUMN IF EXISTS "size_bytes",
--     DROP COLUMN IF EXISTS "content_embedding",
--     DROP COLUMN IF EXISTS "embedding_status",
--     DROP COLUMN IF EXISTS "extracted_text_hash",
--     DROP COLUMN IF EXISTS "embedding_generated_at",
--     DROP COLUMN IF EXISTS "embedding_retry_count",
--     DROP COLUMN IF EXISTS "embedding_last_retry_at";
--   ALTER TABLE "tenants"
--     DROP COLUMN IF EXISTS "storage_file_bytes_used",
--     DROP COLUMN IF EXISTS "storage_file_bytes_used_at",
--     DROP COLUMN IF EXISTS "storage_file_bytes_peak_this_month",
--     DROP COLUMN IF EXISTS "storage_file_bytes_peak_at",
--     DROP COLUMN IF EXISTS "storage_bucket_bytes_peak_this_month",
--     DROP COLUMN IF EXISTS "file_storage_warning_level",
--     DROP COLUMN IF EXISTS "storage_file_bytes_yesterday";
--   -- その後 `prisma migrate resolve --rolled-back 20260526_file_storage_billing_and_embedding`
--
-- 関連:
--   - ADR: docs/adr/0021-file-storage-usage-based-billing.md
--   - config: src/config/file-storage-pricing.ts (SI 単位 / 計算ヘルパ / 危険拡張子)
--   - billing-feature-units: src/config/billing-feature-units.ts ('storage-file-overage' 追加)
--   - 計測: src/services/file-storage-bucket-usage.service.ts (P3 で実装予定)
--   - 月初請求: src/services/tenant-monthly-reset.service.ts (P4 で改修予定)
