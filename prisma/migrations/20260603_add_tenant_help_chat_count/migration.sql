-- ADR-0027 (2026-05-29): たすきフクロウ AI ヘルプチャット (LEARNING_FREE) の月次回数カウンタ。
-- 全プラン無料 (学習コストとして運営吸収)、テナント単位月 100 回上限。
-- 月次リセット (= 0) は tenant-monthly-reset.service.ts に PR6 で組み込む。
ALTER TABLE "tenants"
  ADD COLUMN "current_month_help_chat_count" INTEGER NOT NULL DEFAULT 0;
