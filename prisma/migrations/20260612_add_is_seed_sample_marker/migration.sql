-- 2026-06-05 (feat/starter-data-import): スターターデータ一括取込/削除のための識別マーカー列。
-- 目的:
--   テナント設定画面の「サンプルデータ一括追加」で投入した行を、後から「サンプル一括削除」で
--   正確に特定して論理削除できるようにする。
-- 設計:
--   - is_sample_data (= 提案用シード / 一覧非表示) とは別軸の独立フラグ。
--     取込データは is_sample_data=false (= 一覧に通常表示) のまま is_seed_sample=true を付与する。
--   - 既存行は default false で影響なし。バックフィルしない。
--   - 一括削除は WHERE tenant_id = $self AND is_seed_sample = true で対象を限定 (テナント隔離 + 誤削除防止)。
--   - partial index (is_seed_sample = true の行のみ) で削除クエリを高速化。is_sample_data と同方式。

ALTER TABLE "customers"      ADD COLUMN IF NOT EXISTS "is_seed_sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "projects"       ADD COLUMN IF NOT EXISTS "is_seed_sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "knowledges"     ADD COLUMN IF NOT EXISTS "is_seed_sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "risks_issues"   ADD COLUMN IF NOT EXISTS "is_seed_sample" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "retrospectives" ADD COLUMN IF NOT EXISTS "is_seed_sample" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "idx_customers_is_seed_sample"
  ON "customers" ("is_seed_sample")
  WHERE "is_seed_sample" = true;

CREATE INDEX IF NOT EXISTS "idx_projects_is_seed_sample"
  ON "projects" ("is_seed_sample")
  WHERE "is_seed_sample" = true;

CREATE INDEX IF NOT EXISTS "idx_knowledges_is_seed_sample"
  ON "knowledges" ("is_seed_sample")
  WHERE "is_seed_sample" = true;

CREATE INDEX IF NOT EXISTS "idx_risks_is_seed_sample"
  ON "risks_issues" ("is_seed_sample")
  WHERE "is_seed_sample" = true;

CREATE INDEX IF NOT EXISTS "idx_retro_is_seed_sample"
  ON "retrospectives" ("is_seed_sample")
  WHERE "is_seed_sample" = true;
