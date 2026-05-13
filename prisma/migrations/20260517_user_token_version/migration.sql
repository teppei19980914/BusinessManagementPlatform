-- 2026-05-13 (security/jwt-invalidation, L-1): JWT 失効カウンタ列を User に追加。
--   admin 操作 (password 変更 / ロック解除 / 削除 / ロール変更) で increment し、
--   API route 入口の getAuthenticatedUser で DB の最新値と JWT 内の値を比較する。
--   不一致 = 既存 JWT は失効しているとみなして 401 を返す。
--
-- 既存ユーザは default 0 で開始 (現状の JWT も tokenVersion=0 として有効扱い)。
-- 本 migration 適用後の新規ログインから JWT に tokenVersion 値が刻まれる。

ALTER TABLE "users"
ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;
