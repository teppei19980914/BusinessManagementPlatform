-- WBS階層管理: ワークパッケージ/アクティビティの区別を追加
-- type: 'work_package' (WP) or 'activity' (ACT)

-- 1. type カラムを追加（既存レコードは 'activity' として扱う）
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "type" VARCHAR(20) NOT NULL DEFAULT 'activity';

-- 2. assignee_id を nullable に変更（WP は担当者なし）
ALTER TABLE "tasks" ALTER COLUMN "assignee_id" DROP NOT NULL;

-- 3. planned_start_date / planned_end_date を nullable に変更（WP は子から自動計算）
ALTER TABLE "tasks" ALTER COLUMN "planned_start_date" DROP NOT NULL;
ALTER TABLE "tasks" ALTER COLUMN "planned_end_date" DROP NOT NULL;

-- 4. planned_effort のデフォルト値を設定
ALTER TABLE "tasks" ALTER COLUMN "planned_effort" SET DEFAULT 0;
