-- ADR-0016 ロールバック SQL
--
-- 万一 multi-tenant 化に致命的問題が発覚した場合の緊急ロールバック用。
-- prisma migrate では実行されない (= 手動実行のみ)。
--
-- 注意:
--   ロールバック実行前に、複数テナント間で同一 email が存在しないことを確認:
--     SELECT email, COUNT(*) FROM users GROUP BY email HAVING COUNT(*) > 1;
--   1 件でも存在すれば、旧グローバル UNIQUE 制約に戻せない (= 違反になる)
--   その場合は手動 cleanup 必要

-- Step 1: 新 UNIQUE index を DROP
DROP INDEX IF EXISTS "idx_users_tenant_email";

-- Step 2: 旧 UNIQUE index を CREATE (= グローバル一意に戻す)
CREATE UNIQUE INDEX "idx_users_email" ON "users"("email");
