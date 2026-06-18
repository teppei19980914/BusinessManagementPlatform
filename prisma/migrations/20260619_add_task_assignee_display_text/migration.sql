-- WP の複数担当者表示テキスト列を追加
-- WP に子 ACT の担当者が複数いる場合、"田中 +2" 形式の表示文字列を保持する。
-- 単一担当者の場合は NULL (既存の assignee relation から名前を表示)。
ALTER TABLE "tasks" ADD COLUMN "assignee_display_text" VARCHAR(200);
