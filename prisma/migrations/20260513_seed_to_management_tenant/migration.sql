-- 2026-05-09 (PR G / #24 + 設計合意 B): シードデータを管理テナントに集中
--
-- 設計合意 B (2026-05-09):
--   シードデータはシステム管理者用テナント (MANAGEMENT_TENANT_ID) に実データとして保管する。
--   Default テナントを含むそれ以外のテナントは「提案機能から参照のみ」(現状のクロステナント
--   検索を維持)。これによりシステム管理者用テナントの画面でシード CRUD が可能になり、
--   一般テナントの画面にはシードが「自テナントデータ」として混入しない。
--
-- #24: テナント別の「提案にシードを含めるか」toggle 追加。
--   tenant.seed_data_enabled = TRUE (default) → 提案候補に管理テナントのシードを含める
--   FALSE → 提案候補から MANAGEMENT_TENANT_ID のデータを除外する
--
-- 移行内容:
--   1. tenants に seed_data_enabled BOOLEAN NOT NULL DEFAULT true を追加 (#24)
--   2. is_sample_data = TRUE の業務データ (Project / Knowledge / RiskIssue / Retrospective)
--      を default tenant から management tenant に tenant_id を移動 (合意 B)
--      ※ isSampleData=true は seed-suggestion.ts スクリプトでマークされたデータのみ。
--      ※ 一般テナント・default のリアルデータには影響しない。
--
-- べき等性: 全 ALTER は IF NOT EXISTS、UPDATE は冪等 (既に管理テナントなら NO-OP)。

-- ---------- 1. seed_data_enabled 列を追加 ----------
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "seed_data_enabled" BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN "tenants"."seed_data_enabled" IS '提案エンジンに管理テナントのシードを含めるか (#24)';

-- ---------- 2. シードデータを管理テナントへ移動 (合意 B) ----------
-- Project: is_sample_data=TRUE のもの
UPDATE "projects"
   SET "tenant_id" = '00000000-0000-0000-0000-ffffffffffff'::uuid
 WHERE "tenant_id" = '00000000-0000-0000-0000-000000000001'::uuid
   AND "is_sample_data" = TRUE;

-- Knowledge: is_sample_data=TRUE のもの
UPDATE "knowledges"
   SET "tenant_id" = '00000000-0000-0000-0000-ffffffffffff'::uuid
 WHERE "tenant_id" = '00000000-0000-0000-0000-000000000001'::uuid
   AND "is_sample_data" = TRUE;

-- RiskIssue: 親 project が管理テナントへ移動済のものを追従させる
--   (RiskIssue 自体に is_sample_data カラムはない。Project 経由で識別)
UPDATE "risks_issues"
   SET "tenant_id" = '00000000-0000-0000-0000-ffffffffffff'::uuid
 WHERE "tenant_id" = '00000000-0000-0000-0000-000000000001'::uuid
   AND "project_id" IN (
     SELECT "id" FROM "projects"
      WHERE "tenant_id" = '00000000-0000-0000-0000-ffffffffffff'::uuid
        AND "is_sample_data" = TRUE
   );

-- Retrospective: 同上
UPDATE "retrospectives"
   SET "tenant_id" = '00000000-0000-0000-0000-ffffffffffff'::uuid
 WHERE "tenant_id" = '00000000-0000-0000-0000-000000000001'::uuid
   AND "project_id" IN (
     SELECT "id" FROM "projects"
      WHERE "tenant_id" = '00000000-0000-0000-0000-ffffffffffff'::uuid
        AND "is_sample_data" = TRUE
   );

-- 注: Task は tenant_id 列を持たない (project 経由で属する)。
--   project の tenant_id を上で更新済みなので、Task のクロステナント参照は自動追従する。
