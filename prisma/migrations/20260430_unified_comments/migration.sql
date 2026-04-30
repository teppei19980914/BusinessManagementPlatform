-- PR #199: ポリモーフィックコメント機能の導入。
--   既存の `retrospective_comments` (PR #初期実装で導入されたが UI 未実装) を
--   汎用 `comments` テーブル (entity_type + entity_id) に統合する。
--   7 種のエンティティ (issue/task/risk/retrospective/knowledge/customer/stakeholder)
--   で同一 UI/UX のコメント機能を提供する。

-- ================================================================
-- Step 1: 新テーブル `comments` 作成
-- ================================================================
CREATE TABLE "comments" (
  "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_type" VARCHAR(30)  NOT NULL,
  "entity_id"   UUID         NOT NULL,
  "user_id"     UUID         NOT NULL,
  "content"     TEXT         NOT NULL,
  "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "deleted_at"  TIMESTAMPTZ
);

-- 表示クエリの主索引: entity 単位で deletedAt=NULL を絞り込み、createdAt DESC で並べ替え
CREATE INDEX "idx_comments_entity"
  ON "comments" ("entity_type", "entity_id", "deleted_at");

-- 外部キー: User
ALTER TABLE "comments"
  ADD CONSTRAINT "comments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE NO ACTION;

-- ================================================================
-- Step 2: 旧 `retrospective_comments` のデータ移行
-- ================================================================
-- 旧スキーマ: id, retrospective_id, user_id, content, created_at
-- 新スキーマ: id, entity_type='retrospective', entity_id=retrospective_id,
--             user_id, content, created_at, updated_at=created_at, deleted_at=NULL
INSERT INTO "comments" ("id", "entity_type", "entity_id", "user_id", "content", "created_at", "updated_at", "deleted_at")
SELECT "id", 'retrospective', "retrospective_id", "user_id", "content", "created_at", "created_at", NULL
FROM "retrospective_comments";

-- ================================================================
-- Step 3: 旧テーブル DROP
-- ================================================================
DROP TABLE "retrospective_comments";
