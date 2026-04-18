-- PR #60 マイグレーション: visibility 横展開 + リスク脅威/好機
-- 2026-04-18

-- 1. RiskIssue テーブル: visibility / risk_nature 列を追加
--    visibility は NOT NULL で DEFAULT 'draft'。既存行は全て下書き扱い。
--    risk_nature は nullable (type='risk' のみ意味を持つため)。
ALTER TABLE "risks_issues" ADD COLUMN "visibility" VARCHAR(20) NOT NULL DEFAULT 'draft';
ALTER TABLE "risks_issues" ADD COLUMN "risk_nature" VARCHAR(20);

-- 2. Retrospective テーブル: visibility 列を追加 (同上)
ALTER TABLE "retrospectives" ADD COLUMN "visibility" VARCHAR(20) NOT NULL DEFAULT 'draft';

-- 3. Knowledge テーブル: visibility を draft/public の 2 値体系に統合
--    従来の 'project' / 'company' は全て 'public' に集約する (全員閲覧可の意)。
--    'draft' は作成者のみ閲覧可の意味を維持。
UPDATE "knowledge" SET "visibility" = 'public' WHERE "visibility" IN ('project', 'company');
