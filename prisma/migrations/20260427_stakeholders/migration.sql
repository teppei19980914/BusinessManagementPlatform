-- feat/stakeholder-management: ステークホルダー管理簿
--
-- PMBOK 13 (Stakeholder Management) 準拠フル仕様。プロジェクト詳細画面に新タブとして追加。
-- 内部メンバー (User FK) と外部関係者 (FK 無し) を 1 テーブルで扱い、人物評・対応戦略を
-- 集約管理する。可視性は service 層で PM/TL + admin に限定 (個人情報・人物評を含むため)。
--
-- 設計ドキュメント:
--   - REQUIREMENTS.md (ステークホルダー管理簿)
--   - SPECIFICATION.md (ステークホルダー画面)
--   - DESIGN.md (テーブル定義: stakeholders / 認可: stakeholder アクション)
--
-- ロールバック (緊急時):
--   DROP TABLE stakeholders;

CREATE TABLE "stakeholders" (
  "id"                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  "project_id"         UUID         NOT NULL,
  -- 内部メンバー紐付け (任意)。null なら外部関係者。
  -- ON DELETE SET NULL: User 物理削除時にステークホルダー記録は残す。
  "user_id"            UUID         NULL,
  "name"               VARCHAR(100) NOT NULL,
  "organization"       VARCHAR(100) NULL,
  "role"               VARCHAR(100) NULL,
  "contact_info"       TEXT         NULL,
  -- Mendelow Power/Interest grid: 1-5 段階
  "influence"          SMALLINT     NOT NULL,
  "interest"           SMALLINT     NOT NULL,
  -- 姿勢: supportive | neutral | opposing
  "attitude"           VARCHAR(20)  NOT NULL,
  -- PMBOK 13.1.2 Engagement Assessment Matrix:
  -- unaware | resistant | neutral | supportive | leading
  "current_engagement" VARCHAR(20)  NOT NULL,
  "desired_engagement" VARCHAR(20)  NOT NULL,
  "personality"        TEXT         NULL,
  "tags"               JSONB        NOT NULL DEFAULT '[]'::jsonb,
  "strategy"           TEXT         NULL,
  "created_by"         UUID         NOT NULL,
  "updated_by"         UUID         NOT NULL,
  "created_at"         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "deleted_at"         TIMESTAMPTZ  NULL,
  CONSTRAINT "stakeholders_pkey" PRIMARY KEY ("id")
);

-- FK 制約
ALTER TABLE "stakeholders"
  ADD CONSTRAINT "stakeholders_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id");

ALTER TABLE "stakeholders"
  ADD CONSTRAINT "stakeholders_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE SET NULL;

-- CHECK 制約: 1-5 段階の整合性 (DB 層でも Zod validator と同じ範囲を強制)
ALTER TABLE "stakeholders"
  ADD CONSTRAINT "stakeholders_influence_range"
  CHECK ("influence" BETWEEN 1 AND 5);

ALTER TABLE "stakeholders"
  ADD CONSTRAINT "stakeholders_interest_range"
  CHECK ("interest" BETWEEN 1 AND 5);

-- インデックス
CREATE INDEX "idx_stakeholders_project" ON "stakeholders" ("project_id");
CREATE INDEX "idx_stakeholders_user"    ON "stakeholders" ("user_id");
