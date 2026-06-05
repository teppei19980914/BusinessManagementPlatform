-- 2026-06-04 rollback: ADR-0032 で撤廃した tasks の部分 UNIQUE インデックスを再作成する
--   (= ADR-0017 の元 migration `20260525_tasks_unique_parent_name` を再適用)。
--
-- 適用条件:
--   - 20260610_drop_tasks_unique_parent_name/migration.sql の適用を巻き戻す場合のみ。
--   - ⚠️ 撤廃後に「同一 (project_id, parent_task_id, name) のアクティブな tasks 行」が
--     作成されていると、UNIQUE インデックス再作成は失敗する。
--     先に scripts/check-task-name-duplicates.ts で重複 0 件を確認し、解消してから実行すること。

-- Pre-check: 既存重複があれば停止 (再作成は重複があると失敗するため事前に明示)
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
    RAISE EXCEPTION '同一 (project_id, parent_task_id, name) を持つアクティブな tasks 行が % 組存在します。解消後に再実行してください', dup_count;
  END IF;
END $$;

CREATE UNIQUE INDEX "idx_tasks_project_parent_name_unique"
ON "tasks" (
  "project_id",
  COALESCE("parent_task_id", '00000000-0000-0000-0000-000000000000'::uuid),
  "name"
)
WHERE "deleted_at" IS NULL;
