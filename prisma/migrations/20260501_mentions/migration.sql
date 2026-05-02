-- PR feat/comment-mentions: コメント本文中の @username / @all 等を構造化保存し、
--   通知配信のソースとして使う。
--
-- データモデル:
--   - kind='user' のみ target_user_id を保持 (個別指定)
--   - kind='all' / 'project_member' / 'role_pm_tl' / 'role_general' / 'role_viewer' / 'assignee':
--     target_user_id は NULL (配信時に動的展開)
--   - コメント削除で cascade 物理削除 (mentions は comment 単位でしか意味を持たない)

CREATE TABLE "mentions" (
  "id"             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "comment_id"     UUID         NOT NULL,
  "kind"           VARCHAR(40)  NOT NULL,
  "target_user_id" UUID,
  "created_at"     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- comment_id の取得を高速化 (新規コメント投稿時の旧 mention 取得 + 編集時の差分検出)
CREATE INDEX "idx_mentions_comment"
  ON "mentions" ("comment_id");

-- 外部キー: Comment (cascade 削除)
ALTER TABLE "mentions"
  ADD CONSTRAINT "mentions_comment_id_fkey"
  FOREIGN KEY ("comment_id") REFERENCES "comments"("id")
  ON UPDATE CASCADE ON DELETE CASCADE;

-- 外部キー: User (個別指定の target、グループメンションは NULL)
ALTER TABLE "mentions"
  ADD CONSTRAINT "mentions_target_user_id_fkey"
  FOREIGN KEY ("target_user_id") REFERENCES "users"("id")
  ON UPDATE CASCADE ON DELETE NO ACTION;
