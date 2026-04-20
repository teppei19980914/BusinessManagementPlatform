-- PR #70: 個人メモ機能 (プロジェクトに紐付かない個人の知見・作業ノート)
-- visibility='private' (既定) で本人のみ閲覧可、'public' で「全メモ」画面に公開

CREATE TABLE "memos" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    UUID        NOT NULL,
  "title"      VARCHAR(150) NOT NULL,
  "content"    TEXT        NOT NULL,
  "visibility" VARCHAR(20) NOT NULL DEFAULT 'private',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL,
  "deleted_at" TIMESTAMPTZ,
  CONSTRAINT "memos_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "memos"
  ADD CONSTRAINT "memos_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 自分のメモ一覧 (更新順) の高速化
CREATE INDEX "idx_memos_user_recent"
  ON "memos" ("user_id", "created_at" DESC);

-- 全メモ (公開のみ) 画面での並び替え高速化
CREATE INDEX "idx_memos_visibility_recent"
  ON "memos" ("visibility", "created_at" DESC);
