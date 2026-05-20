-- ADR-0016 (2026-05-20): User.email を tenant-scoped 一意化
--
-- 目的:
--   旧 @@unique([email]) (グローバル一意) → @@unique([tenantId, email]) に変更
--   同一個人が複数テナントに同じ email で所属可能になる (Slack/Notion 系の標準設計)
--   テナント削除後の email 再利用問題を解消
--
-- 本番 DB 事前確認 (2026-05-20):
--   - duplicate email 0 件 (= migration 安全)
--   - 削除済 vs アクティブ email 衝突 0 件
--   - 既存 7 ユーザ / 2 テナント (= MANAGEMENT + Default)
--
-- ロールバック:
--   万一問題発生時、本ファイルの逆 SQL を rollback.sql に記録済
--   (prisma/migrations/20260520_users_email_tenant_scoped_unique/rollback.sql)
--
-- 影響:
--   - 既存ユーザは全員 tenantId を持つため migration 安全
--   - 既存 JWT は無効化される (= 全ユーザ強制ログアウト、運営者承諾済)
--   - 認証フロー側で tenantSlug 必須化が別途必要 (= Phase 4 で対応)

-- Step 1: 旧 UNIQUE index を DROP
DROP INDEX IF EXISTS "idx_users_email";

-- Step 2: 新複合 UNIQUE index を CREATE
CREATE UNIQUE INDEX "idx_users_tenant_email" ON "users"("tenant_id", "email");
