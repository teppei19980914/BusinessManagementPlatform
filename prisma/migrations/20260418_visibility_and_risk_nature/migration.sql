-- PR #60 マイグレーション: visibility 横展開 + リスク脅威/好機
-- 2026-04-18

-- 1. RiskIssue テーブル: visibility / risk_nature 列を追加
--    visibility は NOT NULL で DEFAULT 'draft'。既存行は全て下書き扱い。
--    risk_nature は nullable (type='risk' のみ意味を持つため)。
ALTER TABLE "risks_issues" ADD COLUMN "visibility" VARCHAR(20) NOT NULL DEFAULT 'draft';
ALTER TABLE "risks_issues" ADD COLUMN "risk_nature" VARCHAR(20);

-- 2. Retrospective テーブル: visibility 列を追加 (同上)
ALTER TABLE "retrospectives" ADD COLUMN "visibility" VARCHAR(20) NOT NULL DEFAULT 'draft';

-- 3. Knowledge テーブル (実テーブル名は knowledges、Prisma model @@map): visibility を draft/public の 2 値体系に統合
--    従来の 'project' / 'company' は全て 'public' に集約する (全員閲覧可の意)。
--    'draft' は作成者のみ閲覧可の意味を維持。
--
-- PR #90 修正: 元の UPDATE 対象は "knowledge" と単数形で記述されていたが、
--             実テーブル名は "knowledges" (Prisma @@map("knowledges")) のため
--             fresh DB への `prisma migrate deploy` が ERROR 42P01 で fail していた。
--             本番 DB は README の手動マイグレーション手順で既に適用済み (PR #62)。
--             本 PR で CI ephemeral Postgres 上でも成功するよう file を正しい複数形に修正。
UPDATE "knowledges" SET "visibility" = 'public' WHERE "visibility" IN ('project', 'company');
