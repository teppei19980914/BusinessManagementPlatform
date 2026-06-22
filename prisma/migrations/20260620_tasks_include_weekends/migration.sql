-- 2026-06-20: タスクに「土日祝日を含める」フラグを追加
-- includeWeekends=false (デフォルト): 平日のみ稼働日として工数分散
-- includeWeekends=true : 土日祝日も稼働日に含む（休日出勤想定）
ALTER TABLE "tasks" ADD COLUMN "include_weekends" BOOLEAN NOT NULL DEFAULT FALSE;
