-- 分析タブ「担当者別 週次消化工数」/ 工数効率のための実績工数列を追加。
-- ACT の実績工数 (担当者が実績入力)。null = 未入力。WP は集計対象外 (子 ACT を集計する将来拡張余地)。
-- 非破壊 (nullable 列の追加のみ。既存行は null)。
ALTER TABLE "tasks" ADD COLUMN "actual_effort" numeric(10, 2);
