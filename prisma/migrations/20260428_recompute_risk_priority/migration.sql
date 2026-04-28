-- PR-γ / 項目 2 + 7:
--   既存リスク/課題の priority を 4 値 (high/medium/low/minimal) で再計算する。
--   computePriority() の SQL 等価実装。
--
-- 算出マトリクス:
--   risk (発生確率重視):  high+high→high, low+high→medium, high+low→low, low+low→minimal
--   issue (重要度重視):   high+high→high, high+low→medium, low+high→low, low+low→minimal
--
-- 'medium' は 'high' 寄り扱い (高側に寄せる安全側評価)。
-- likelihood が NULL の場合は 'low' 扱い (issue で likelihood 未設定の既存データ向け)。

UPDATE "risks_issues" SET "priority" = (
  CASE
    WHEN "type" = 'risk' THEN
      CASE
        WHEN ("impact" IN ('high','medium')) AND (COALESCE("likelihood", 'low') IN ('high','medium')) THEN 'high'
        WHEN ("impact" = 'low')              AND (COALESCE("likelihood", 'low') IN ('high','medium')) THEN 'medium'
        WHEN ("impact" IN ('high','medium')) AND (COALESCE("likelihood", 'low') = 'low')              THEN 'low'
        ELSE 'minimal'
      END
    ELSE
      CASE
        WHEN ("impact" IN ('high','medium')) AND (COALESCE("likelihood", 'low') IN ('high','medium')) THEN 'high'
        WHEN ("impact" IN ('high','medium')) AND (COALESCE("likelihood", 'low') = 'low')              THEN 'medium'
        WHEN ("impact" = 'low')              AND (COALESCE("likelihood", 'low') IN ('high','medium')) THEN 'low'
        ELSE 'minimal'
      END
  END
);
