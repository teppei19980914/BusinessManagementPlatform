-- PR feat/notifications-mvp: アプリ内通知機能の DB 基盤。
--   - notifications テーブル (polymorphic、Comment / Attachment と同パターン)
--   - tasks の cron クエリ高速化用 partial index 2 本
--     (毎朝 7:00 JST に当日分の ACT を抽出する query で seq scan を回避)

-- ================================================================
-- Step 1: notifications テーブル作成
-- ================================================================
CREATE TABLE "notifications" (
  "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     UUID         NOT NULL,
  "type"        VARCHAR(40)  NOT NULL,
  "entity_type" VARCHAR(30)  NOT NULL,
  "entity_id"   UUID         NOT NULL,
  "title"       VARCHAR(200) NOT NULL,
  "link"        VARCHAR(500) NOT NULL,
  "dedupe_key"  VARCHAR(200) NOT NULL,
  "read_at"     TIMESTAMPTZ,
  "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 重複抑止: 同じトリガが同じ user に 2 回作られないよう DB レベルで弾く
CREATE UNIQUE INDEX "idx_notifications_dedupe"
  ON "notifications" ("dedupe_key");

-- ベル UI 用の主索引: user 別 + 未読/既読別 + 新しい順
CREATE INDEX "idx_notifications_user_unread"
  ON "notifications" ("user_id", "read_at", "created_at" DESC);

-- 外部キー: User
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

-- ================================================================
-- Step 2: tasks の cron クエリ高速化用 partial index
-- ================================================================
-- 毎朝 7:00 JST に走る cron が叩く 2 本の query を高速化する。
-- 全タスク seq scan を避けるため、cron が引く条件 (type='activity' AND deletedAt IS NULL
-- AND assigneeId IS NOT NULL) で絞った partial index にする。
--
-- Q1 (開始通知): WHERE planned_start_date = $today
-- Q2 (終了通知): WHERE planned_end_date = $today AND status != 'completed'
--
-- どちらも 1 日数十〜数百件のタスクヒットを想定。partial index で全 task scan 回避。

CREATE INDEX "idx_tasks_planned_start_due"
  ON "tasks" ("planned_start_date")
  WHERE "deleted_at" IS NULL
    AND "type" = 'activity'
    AND "assignee_id" IS NOT NULL
    AND "status" = 'not_started';

CREATE INDEX "idx_tasks_planned_end_due"
  ON "tasks" ("planned_end_date")
  WHERE "deleted_at" IS NULL
    AND "type" = 'activity'
    AND "assignee_id" IS NOT NULL
    AND "status" <> 'completed';
