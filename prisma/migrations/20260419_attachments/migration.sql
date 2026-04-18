-- PR #64 Phase 1: 汎用添付リンクテーブル (attachments)
-- 実ファイルは保持せず、外部ストレージ URL のみを格納する。
-- ポリモーフィック関連 (entity_type + entity_id) により 6 種のエンティティと連携。
-- 単数/複数スロットの enforcement は UI/サービス層で行い、DB は複数行を許容する。

CREATE TABLE "attachments" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "entity_type"  VARCHAR(30) NOT NULL,
  "entity_id"    UUID        NOT NULL,
  "slot"         VARCHAR(30) NOT NULL DEFAULT 'general',
  "display_name" VARCHAR(200) NOT NULL,
  "url"          VARCHAR(2000) NOT NULL,
  "mime_hint"    VARCHAR(50),
  "added_by"     UUID        NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMPTZ NOT NULL,
  "deleted_at"   TIMESTAMPTZ,
  CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- FK: added_by → users.id (参照整合性とカスケード挙動のため)
ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_added_by_fkey"
  FOREIGN KEY ("added_by") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- インデックス: エンティティ単位の一覧取得で使用 (大半のクエリは entity_type + entity_id)
CREATE INDEX "idx_attachments_entity"
  ON "attachments" ("entity_type", "entity_id");

-- インデックス: slot 絞り込み (SingleUrlField 相当の単数スロット検索)
CREATE INDEX "idx_attachments_slot"
  ON "attachments" ("entity_type", "entity_id", "slot");
