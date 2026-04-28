-- PR-β / 項目 13 + 14:
--   1. dev_method の旧値 'power_platform' を 'low_code_no_code' にリネーム
--      (master-data.ts の DEV_METHODS と整合)
--   2. projects に contract_type 列を新設 (NULL 許容、既存プロジェクトは未設定)

-- 1. 既存データを更新 (Project + Estimate + Knowledge の 3 テーブル)
--    note (PR-β E2E hotfix): dev_method 列は Knowledge (knowledges テーブル) に存在。
--    KnowledgeProject (knowledge_projects テーブル) は多対多の関連テーブルで dev_method を持たない
--    (init migration 確認済)。当初 knowledge_projects と書いていたが column が存在せず P3018 エラー
--    で migration 失敗したため knowledges に修正。
UPDATE "projects" SET "dev_method" = 'low_code_no_code' WHERE "dev_method" = 'power_platform';
UPDATE "estimates" SET "dev_method" = 'low_code_no_code' WHERE "dev_method" = 'power_platform';
UPDATE "knowledges" SET "dev_method" = 'low_code_no_code' WHERE "dev_method" = 'power_platform';

-- 2. projects.contract_type 列追加
ALTER TABLE "projects" ADD COLUMN "contract_type" VARCHAR(30);
