-- Phase 1 (2026-05-08): 外部データ移行 (Knowledge + RiskIssue) MVP の DB 変更
--
-- 変更内容:
--   1. tenant_import_preview テーブル新設
--      - preview API → apply API の 2 段階フローで「検証済データ」を 24 時間保持する
--      - apply 時に再パースを避け、preview 時の見積と現在の状況を比較するための受け皿
--   2. tenant_monthly_usage_history に Storage add-on 関連カラムを前方互換で追加
--      - Phase 2 (Storage add-on 実装) で実値投入される予定
--      - Phase 1 では値は default (0 / 'standard') のまま記録される
--      - super_admin ダッシュボード拡張で集計表示するための準備
--
-- 関連:
--   - サービス: src/services/external-data-import.service.ts
--   - 計画: docs/roadmap/V1_FINAL_TASKS.md (Phase 1)

-- ================================================================
-- 1. tenant_import_preview 新設
-- ================================================================
CREATE TABLE "tenant_import_preview" (
    "id"                  UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"           UUID         NOT NULL,
    "created_by_user_id"  UUID         NOT NULL,
    "parsed_json"         JSONB        NOT NULL,
    "cost_estimate"       JSONB        NOT NULL,
    "summary"             JSONB        NOT NULL,
    "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "expires_at"          TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "tenant_import_preview_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tenant_import_preview"
  ADD CONSTRAINT "tenant_import_preview_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "tenant_import_preview"
  ADD CONSTRAINT "tenant_import_preview_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "idx_tenant_import_preview_tenant"
  ON "tenant_import_preview"("tenant_id", "created_at" DESC);

CREATE INDEX "idx_tenant_import_preview_expires"
  ON "tenant_import_preview"("expires_at");

-- ================================================================
-- 2. tenant_monthly_usage_history に Storage 関連カラム追加
-- ================================================================
ALTER TABLE "tenant_monthly_usage_history"
  ADD COLUMN "storage_bytes_used"   BIGINT       NOT NULL DEFAULT 0,
  ADD COLUMN "storage_addon_plan"   VARCHAR(20)  NOT NULL DEFAULT 'standard',
  ADD COLUMN "storage_addon_jpy"    INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN "total_jpy"            INTEGER      NOT NULL DEFAULT 0;
