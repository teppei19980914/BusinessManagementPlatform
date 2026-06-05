-- 2026-06-02: Project に実績日カラムを追加 (任意・nullable)。
--   COLUMN_USAGE_MAP の ToBe (actualStartDate / actualEndDate) を実装。
--   予定日 (planned_*) は必須だが実績日は着手前は未確定のため nullable。
ALTER TABLE "projects" ADD COLUMN "actual_start_date" DATE;
ALTER TABLE "projects" ADD COLUMN "actual_end_date" DATE;
