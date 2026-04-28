-- T-21 (PR-η バグ修正): 永続ロック発火経路を実装するため、users に
--   temporary_lock_count 列を新設。デフォルト 0、既存ユーザも 0 始まり。
--
-- 経緯 (DEVELOPER_GUIDE §5.29 参照):
--   - users-client.tsx:216 のコメント「3 回目で permanentLock」に対応する実装が
--     auth.ts に存在せず、permanentLock=true にする経路がコードベース全体で grep 0 件だった
--   - 修正方針 §5.29 選択肢 A: 一時ロック発生時に temporaryLockCount を +1、
--     閾値 (PERMANENT_LOCK_THRESHOLD=3) 到達で permanentLock=true をセット
--   - ログイン成功時には failedLoginCount=0 と同じく temporaryLockCount も 0 にリセット
--
-- 適用上の注意 (本日 P2022 障害の教訓、E2E §4.44):
--   Vercel build では prisma migrate deploy を実行しないため、本 migration の本番適用は
--   Supabase ダッシュボード → SQL Editor で手動実行が必要。
--   `pnpm migrate:print 20260428_user_temporary_lock_count` で SQL 全文を取得可。

ALTER TABLE "users" ADD COLUMN "temporary_lock_count" INTEGER NOT NULL DEFAULT 0;
