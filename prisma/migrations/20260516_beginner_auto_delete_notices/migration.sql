-- 2026-05-11: Beginner 自動物理削除 (Day 180) の中間警告メール用カラム追加
--
-- 背景:
--   - 既存: Day 60 / 75 / 90 で警告 + read-only 移行通知のみ
--   - 追加: Day 180 自動物理削除に向けて、Day 150 (削除 30 日前) と Day 170 (削除 10 日前) の
--     最終予告メールを追加。冪等性のため送信日時カラムを 2 件用意する。
--
-- 関連:
--   - 実装: src/services/beginner-expiry.service.ts (sendBeginnerExpiryNotices 拡張)
--   - cron: /api/cron/daily-usage-aggregation
--   - 削除実行: src/services/super-admin.service.ts purgeExpiredBeginnerTenants

ALTER TABLE "tenants"
  ADD COLUMN "beginner_auto_delete_notice_day150_sent_at" TIMESTAMPTZ,
  ADD COLUMN "beginner_auto_delete_notice_day170_sent_at" TIMESTAMPTZ;
