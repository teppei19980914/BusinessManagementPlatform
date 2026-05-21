-- 2026-05-25 rollback: tasks の (project_id, parent_task_id, name) 部分 UNIQUE インデックスを削除
--
-- 適用条件:
--   - 20260525_tasks_unique_parent_name/migration.sql の適用後、運用上問題が発生した場合のみ。
--   - DROP INDEX は ACCESS EXCLUSIVE lock を一瞬取るが影響は小さい。

DROP INDEX IF EXISTS "idx_tasks_project_parent_name_unique";
