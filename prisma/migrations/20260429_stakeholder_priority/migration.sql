-- Phase D 要件 11/12 (2026-04-28):
--   ステークホルダーに優先度カラム (high/medium/low) を追加し、
--   PMBOK Power/Interest grid (influence/interest >= 4 = 大) から自動分類した値で backfill する。
--
-- 分類マトリクス (deriveStakeholderPriority と一致させる):
--   manage_closely (influence>=4 AND interest>=4) → high
--   keep_satisfied (influence>=4 AND interest<4)  → medium
--   keep_informed  (influence<4  AND interest>=4) → medium
--   monitor        (influence<4  AND interest<4)  → low

ALTER TABLE "stakeholders"
  ADD COLUMN "priority" VARCHAR(10) NOT NULL DEFAULT 'medium';

UPDATE "stakeholders" SET "priority" = (
  CASE
    WHEN "influence" >= 4 AND "interest" >= 4 THEN 'high'
    WHEN "influence" <  4 AND "interest" <  4 THEN 'low'
    ELSE 'medium'
  END
);

-- インデックス: 一覧で priority desc(high→medium→low) ソートが頻繁に走るため。
-- enum-as-string の sort は ORDER BY CASE … で行うため複合 index は意味薄い。
-- 単独 index のみ (filter で priority = 'high' 等の絞り込みに効く)。
CREATE INDEX "idx_stakeholders_priority" ON "stakeholders" ("priority");
