-- 2026-05-25: tasks に (project_id, parent_task_id, name) の部分 UNIQUE インデックスを追加
--
-- 目的:
--   WBS sync-import の app 層 validation を DB 制約でも担保する。
--   旧 import 経路や直接 SQL 操作で同一親配下に同名タスクが作成される可能性をブロック。
--   削除済 (deleted_at IS NOT NULL) は対象外 (履歴復元時の偶発衝突を避ける)。
--
-- 設計判断:
--   - Prisma の @@unique は WHERE 句を表現できないため raw SQL migration とする。
--   - parent_task_id IS NULL (root レベル) は Postgres デフォルトでは「NULL ≠ NULL」で
--     重複検知されないため、COALESCE でセンチネル UUID にマップする。
--   - 削除済を含めると undo 操作で UNIQUE 違反になりうるため WHERE deleted_at IS NULL で部分化。
--
-- 本番 DB 事前確認手順:
--   1. scripts/check-task-name-duplicates.ts を実行し duplicate 0 件を確認
--   2. 1 件以上ある場合は app 層で名称変更 or 親変更で解消してから migration を適用
--   3. CREATE UNIQUE INDEX は ACCESS EXCLUSIVE lock を一瞬取るため、業務時間外推奨
--
-- ロールバック: prisma/migrations/20260525_tasks_unique_parent_name/rollback.sql 参照

-- Pre-check: 既存重複を Notice 出力 (migration 続行のため fail はしない)
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT project_id, COALESCE(parent_task_id, '00000000-0000-0000-0000-000000000000'::uuid) AS pkey, name
    FROM tasks
    WHERE deleted_at IS NULL
    GROUP BY 1, 2, 3
    HAVING COUNT(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION '同一 (project_id, parent_task_id, name) を持つアクティブな tasks 行が % 組存在します。scripts/check-task-name-duplicates.ts で確認し解消後に再実行してください', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX "idx_tasks_project_parent_name_unique"
ON "tasks" (
  "project_id",
  COALESCE("parent_task_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "name"
)
WHERE "deleted_at" IS NULL;
