-- PR #2 / T-03 提案エンジン v2: マルチテナント基盤 + 課金基盤
--
-- 目的:
--   1. tenants テーブル新設 + default-tenant の単一テナントを挿入
--   2. 13 業務エンティティ + User に tenant_id カラム追加 (DEFAULT default-tenant の UUID)
--   3. api_call_logs テーブル新設 (LLM/Embedding 呼び出しの課金根拠データ)
--
-- 設計判断 (詳細は docs/roadmap/SUGGESTION_ENGINE_PLAN.md PR #2 章参照):
--   - tenant_id は v1 単一テナント運用では DB DEFAULT で default-tenant に自動配属される。
--     これにより既存の INSERT コードを変更せずに本 migration を適用可能。
--     v1.x のマルチテナント UI 提供時に DEFAULT を外し、明示的な tenant_id 指定を強制する。
--   - default-tenant の UUID は固定値 '00000000-0000-0000-0000-000000000001'。
--     コード中でも同 UUID を `DEFAULT_TENANT_ID` 定数として参照する。
--   - 既存行の backfill は不要 (DEFAULT が ALTER TABLE 時に既存行に自動適用される PostgreSQL の仕様)。
--
-- 適用順:
--   Step 1: tenants テーブル作成
--   Step 2: default-tenant 行を挿入
--   Step 3: api_call_logs テーブル作成
--   Step 4: 14 エンティティに tenant_id カラム追加 + FK + index
--
-- ロールバック方針:
--   本 migration は破壊的でない (カラム追加のみ、既存データに影響なし)。
--   万一 rollback が必要な場合は逆順に DROP COLUMN / DROP TABLE を実施 (本ファイルでは管理せず、
--   docs/operations/DB_MIGRATION_PROCEDURE.md の手順書に従う)。

-- ================================================================
-- Step 1: tenants テーブル作成
-- ================================================================
CREATE TABLE "tenants" (
  "id"                            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"                          VARCHAR(60)  NOT NULL,
  "name"                          VARCHAR(100) NOT NULL,
  "plan"                          VARCHAR(20)  NOT NULL DEFAULT 'beginner',
  "current_month_api_call_count"  INTEGER      NOT NULL DEFAULT 0,
  "current_month_api_cost_jpy"    INTEGER      NOT NULL DEFAULT 0,
  "monthly_budget_cap_jpy"        INTEGER,
  "beginner_monthly_call_limit"   INTEGER      NOT NULL DEFAULT 100,
  "beginner_max_seats"            INTEGER      NOT NULL DEFAULT 5,
  "price_per_call_haiku"          INTEGER      NOT NULL DEFAULT 10,
  "price_per_call_sonnet"         INTEGER      NOT NULL DEFAULT 30,
  "scheduled_plan_change_at"      TIMESTAMPTZ,
  "scheduled_next_plan"           VARCHAR(20),
  "last_reset_at"                 TIMESTAMPTZ,
  "created_at"                    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"                    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "deleted_at"                    TIMESTAMPTZ
);

CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" ("slug");
CREATE INDEX "idx_tenants_plan" ON "tenants" ("plan");

-- ================================================================
-- Step 2: default-tenant 挿入 (固定 UUID)
-- ================================================================
-- 既存の単一環境運用を継続するための単一テナント。
-- 本 row を起点に、すべての既存業務データが配属される (DEFAULT で自動)。
INSERT INTO "tenants" ("id", "slug", "name", "plan")
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'default',
  'Default',
  'beginner'
);

-- ================================================================
-- Step 3: api_call_logs テーブル作成 (課金根拠データ)
-- ================================================================
CREATE TABLE "api_call_logs" (
  "id"                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"         UUID         NOT NULL,
  "user_id"           UUID,
  "feature_unit"      VARCHAR(40)  NOT NULL,
  "model_name"        VARCHAR(60)  NOT NULL,
  "llm_input_tokens"  INTEGER,
  "llm_output_tokens" INTEGER,
  "embedding_tokens"  INTEGER,
  "cost_jpy"          INTEGER      NOT NULL,
  "latency_ms"        INTEGER      NOT NULL,
  "request_id"        VARCHAR(64)  NOT NULL,
  "created_at"        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX "idx_api_call_logs_tenant"  ON "api_call_logs" ("tenant_id", "created_at" DESC);
CREATE INDEX "idx_api_call_logs_request" ON "api_call_logs" ("request_id");
CREATE INDEX "idx_api_call_logs_feature" ON "api_call_logs" ("feature_unit", "created_at" DESC);

ALTER TABLE "api_call_logs"
  ADD CONSTRAINT "api_call_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

ALTER TABLE "api_call_logs"
  ADD CONSTRAINT "api_call_logs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

-- ================================================================
-- Step 4: 14 エンティティに tenant_id カラム追加
-- ================================================================
-- ADD COLUMN ... NOT NULL DEFAULT '00000000-...' は PostgreSQL 11+ で
-- メタデータのみの変更となり、既存行の書き換えは発生しない (高速)。
-- 既存行は DEFAULT 値が論理的に適用され、本 migration 完了時点で全行が
-- default-tenant に配属された状態となる。

-- ---------- 4.1 users ----------
ALTER TABLE "users" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "users"
  ADD CONSTRAINT "users_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_users_tenant" ON "users" ("tenant_id");

-- ---------- 4.2 customers ----------
ALTER TABLE "customers" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_customers_tenant" ON "customers" ("tenant_id");

-- ---------- 4.3 projects ----------
ALTER TABLE "projects" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_projects_tenant" ON "projects" ("tenant_id");

-- ---------- 4.4 risks_issues ----------
ALTER TABLE "risks_issues" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "risks_issues"
  ADD CONSTRAINT "risks_issues_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_risks_tenant" ON "risks_issues" ("tenant_id");

-- ---------- 4.5 retrospectives ----------
ALTER TABLE "retrospectives" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "retrospectives"
  ADD CONSTRAINT "retrospectives_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_retro_tenant" ON "retrospectives" ("tenant_id");

-- ---------- 4.6 knowledges ----------
ALTER TABLE "knowledges" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "knowledges"
  ADD CONSTRAINT "knowledges_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_knowledges_tenant" ON "knowledges" ("tenant_id");

-- ---------- 4.7 stakeholders ----------
ALTER TABLE "stakeholders" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "stakeholders"
  ADD CONSTRAINT "stakeholders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_stakeholders_tenant" ON "stakeholders" ("tenant_id");

-- ---------- 4.8 memos ----------
ALTER TABLE "memos" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "memos"
  ADD CONSTRAINT "memos_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_memos_tenant" ON "memos" ("tenant_id");

-- ---------- 4.9 attachments ----------
ALTER TABLE "attachments" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_attachments_tenant" ON "attachments" ("tenant_id");

-- ---------- 4.10 comments ----------
ALTER TABLE "comments" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "comments"
  ADD CONSTRAINT "comments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_comments_tenant" ON "comments" ("tenant_id");

-- ---------- 4.11 mentions ----------
ALTER TABLE "mentions" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "mentions"
  ADD CONSTRAINT "mentions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_mentions_tenant" ON "mentions" ("tenant_id");

-- ---------- 4.12 notifications ----------
ALTER TABLE "notifications" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_notifications_tenant" ON "notifications" ("tenant_id");

-- ---------- 4.13 system_error_logs ----------
ALTER TABLE "system_error_logs" ADD COLUMN "tenant_id" UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE "system_error_logs"
  ADD CONSTRAINT "system_error_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

CREATE INDEX "idx_system_errors_tenant" ON "system_error_logs" ("tenant_id", "created_at" DESC);
