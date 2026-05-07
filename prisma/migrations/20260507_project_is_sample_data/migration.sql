-- PR-X5 (2026-05-07): Project にサンプルデータ識別フラグを追加
--
-- 目的: シーディング用のサンプルプロジェクト (Sample Project A / B 等) を画面上の
--       一覧から隠しつつ、提案エンジンの候補ソースとしてのみ生かす。
--
-- 影響:
--   - 既存全 Project: is_sample_data = false (DEFAULT) で無影響
--   - サービス層は WHERE is_sample_data = false でフィルタ追加 (一覧 / 横断 view)
--   - 提案エンジン側はフィルタなし (候補に含める)
--
-- index 設計:
--   - partial index で is_sample_data = true の行のみインデックス対象。
--   - サンプルは 1 テナントあたり 1〜2 件と少数のため、partial で index サイズ最小化。
--   - 通常クエリは = false の WHERE 句が大半を占めるが、これは default 値で
--     index を引かなくても planner が efficient (sequential scan + filter) と
--     判断するため、partial 設計の方が運用上のオーバーヘッドが小さい。

ALTER TABLE "projects"
  ADD COLUMN "is_sample_data" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "idx_projects_is_sample_data"
  ON "projects" ("is_sample_data")
  WHERE "is_sample_data" = true;
