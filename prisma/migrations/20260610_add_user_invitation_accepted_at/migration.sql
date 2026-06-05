-- 2026-06-03: アカウント状態 (招待中 / 有効 / 無効) の明示化。
-- 背景:
--   旧設計は「招待中」(招待メール送信〜パスワード設定完了まで) を deleted_at(論理削除) で
--   代用していたため、招待中ユーザが一覧から除外され、招待メール再送・招待取消の導線を
--   置けなかった。本カラムで「受諾済みか」を判定し、deleted_at は論理削除専用に戻す。
--   アカウント状態は is_active と合わせて導出する (deriveAccountStatus / user.service.ts):
--     - invitation_accepted_at IS NULL                 -> 招待中
--     - invitation_accepted_at NOT NULL かつ is_active  -> 有効
--     - invitation_accepted_at NOT NULL かつ NOT is_active -> 無効
--   Beginner 席数は「有効 + 招待中」を予約として数える (案A)。

-- 1. カラム追加 (NULL = 招待中 / 値あり = 受諾済)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "invitation_accepted_at" TIMESTAMPTZ;

-- 2. backfill: 既存の有効化済みユーザ (論理削除されていない = すでに受諾済み) は
--    受諾日時を作成日時で補完する。正確な受諾時刻の記録は無いため created_at を近似値とする。
UPDATE "users"
SET "invitation_accepted_at" = "created_at"
WHERE "deleted_at" IS NULL
  AND "invitation_accepted_at" IS NULL;

-- 注: 旧設計で deleted_at を立てて保留していた「未受諾の招待中」ユーザは、削除済みユーザとの
--     安全な区別が列だけでは不能なため、本マイグレーションでは論理削除済みのまま据え置く。
--     保留中の招待が必要な場合はテナント管理者が「メンバーを招待」から再送信できる
--     (createUser の重複メール処理が旧レコードを掃除して再登録を許可する)。
