-- PR-β / 項目 13 + 14:
--   1. dev_method の旧値 'power_platform' を 'low_code_no_code' にリネーム
--      (master-data.ts の DEV_METHODS と整合)
--   2. projects に contract_type 列を新設 (NULL 許容、既存プロジェクトは未設定)

-- 1. 既存データを更新 (Project + Estimate + KnowledgeProject の 3 テーブル)
UPDATE "projects" SET "dev_method" = 'low_code_no_code' WHERE "dev_method" = 'power_platform';
UPDATE "estimates" SET "dev_method" = 'low_code_no_code' WHERE "dev_method" = 'power_platform';
UPDATE "knowledge_projects" SET "dev_method" = 'low_code_no_code' WHERE "dev_method" = 'power_platform';

-- 2. projects.contract_type 列追加
ALTER TABLE "projects" ADD COLUMN "contract_type" VARCHAR(30);
