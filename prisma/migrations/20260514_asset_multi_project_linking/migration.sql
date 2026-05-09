-- 2026-05-09 (PR feat/asset-multi-project-linking — Phase 1: データ基盤):
--   リスク / 課題 / 振り返り を **多対多 (M:N)** にして、Knowledge と同型の紐付けモデルに統一する。
--
-- ユーザストーリー (Issue 設計):
--   「A プロジェクトで作成された資産を B プロジェクトで紐付けた場合、
--    A が削除されても、B が参照しているため資産は残る (cascade されない)。
--    B が削除されるとき、他に参照プロジェクトがなければカスケード削除される。
--    『親不在』の状態は、B 削除時に "資産は削除しない" を選択したときだけ発生する。」
--
-- 設計判断:
--   - 既存 risks_issues / retrospectives テーブルの `project_id` 列は **削除せず残す**:
--     新規仕様では「作成元プロジェクト (audit / UI 上の起源表示)」の意味になり、
--     検索 / 一覧 / cascade 駆動はすべて新中間テーブル経由で行う。
--   - 既存 N 行 → 新中間テーブルに 1:1 で展開 (作成元プロジェクトが最初の紐付け先)。
--   - ON DELETE CASCADE で中間テーブル行を物理削除 (Project 削除時 = unlink、
--     RiskIssue/Retrospective 物理削除時 = 子も自動消滅)。
--
-- べき等性: CREATE TABLE IF NOT EXISTS / INSERT ... ON CONFLICT DO NOTHING を徹底。

-- ---------- 1. RiskIssueProject (リスク/課題 ⇔ プロジェクト M:N) ----------

CREATE TABLE IF NOT EXISTS "risk_issue_projects" (
  "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
  "risk_issue_id"  UUID NOT NULL,
  "project_id"     UUID NOT NULL,

  CONSTRAINT "risk_issue_projects_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "risk_issue_projects_risk_issue_project_unique"
    UNIQUE ("risk_issue_id", "project_id"),
  CONSTRAINT "risk_issue_projects_risk_issue_id_fkey"
    FOREIGN KEY ("risk_issue_id") REFERENCES "risks_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "risk_issue_projects_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_risk_issue_projects_project"
  ON "risk_issue_projects" ("project_id");

COMMENT ON TABLE  "risk_issue_projects" IS 'リスク/課題と Project の M:N 中間 (PR feat/asset-multi-project-linking)';
COMMENT ON COLUMN "risk_issue_projects"."risk_issue_id" IS 'リスク/課題本体の id';
COMMENT ON COLUMN "risk_issue_projects"."project_id"    IS '紐付け先プロジェクトの id (作成元 + 参照プロジェクト)';

-- ---------- 2. RetrospectiveProject (振り返り ⇔ プロジェクト M:N) ----------

CREATE TABLE IF NOT EXISTS "retrospective_projects" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "retrospective_id" UUID NOT NULL,
  "project_id"       UUID NOT NULL,

  CONSTRAINT "retrospective_projects_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "retrospective_projects_retro_project_unique"
    UNIQUE ("retrospective_id", "project_id"),
  CONSTRAINT "retrospective_projects_retrospective_id_fkey"
    FOREIGN KEY ("retrospective_id") REFERENCES "retrospectives"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "retrospective_projects_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_retro_projects_project"
  ON "retrospective_projects" ("project_id");

COMMENT ON TABLE "retrospective_projects" IS '振り返りと Project の M:N 中間 (PR feat/asset-multi-project-linking)';

-- ---------- 3. データ移行: 既存 projectId を新中間テーブルに展開 ----------
-- 既存リスク/課題 N 行 → (id, project_id) を 1:1 で risk_issue_projects に挿入。
-- 既存振り返り M 行 → 同様に retrospective_projects に挿入。
-- 削除済 (deleted_at IS NOT NULL) も含めて初期紐付けを設定 (削除済資産でも作成元の audit は残す)。
-- ON CONFLICT DO NOTHING で再実行時もべき等。

INSERT INTO "risk_issue_projects" ("id", "risk_issue_id", "project_id")
SELECT
  gen_random_uuid(),
  ri."id",
  ri."project_id"
FROM "risks_issues" ri
WHERE ri."project_id" IS NOT NULL
ON CONFLICT ("risk_issue_id", "project_id") DO NOTHING;

INSERT INTO "retrospective_projects" ("id", "retrospective_id", "project_id")
SELECT
  gen_random_uuid(),
  r."id",
  r."project_id"
FROM "retrospectives" r
WHERE r."project_id" IS NOT NULL
ON CONFLICT ("retrospective_id", "project_id") DO NOTHING;

-- ---------- 4. risks_issues / retrospectives.project_id を nullable + SET NULL FK 化 ----------
-- 「作成元プロジェクト (createdInProject)」の意味に変更したため、project 物理削除時には
-- NULL に SET される必要がある (orphan を許容するユーザ要件)。

DO $$
BEGIN
  -- risks_issues.project_id NOT NULL → NULLABLE
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'risks_issues' AND column_name = 'project_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "risks_issues" ALTER COLUMN "project_id" DROP NOT NULL;
  END IF;
END $$;

-- 既存の RESTRICT FK を SET NULL に張り替え (べき等)
ALTER TABLE "risks_issues" DROP CONSTRAINT IF EXISTS "risks_issues_project_id_fkey";
ALTER TABLE "risks_issues" ADD CONSTRAINT "risks_issues_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'retrospectives' AND column_name = 'project_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "retrospectives" ALTER COLUMN "project_id" DROP NOT NULL;
  END IF;
END $$;

ALTER TABLE "retrospectives" DROP CONSTRAINT IF EXISTS "retrospectives_project_id_fkey";
ALTER TABLE "retrospectives" ADD CONSTRAINT "retrospectives_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
