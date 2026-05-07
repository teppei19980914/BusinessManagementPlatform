-- PR-X1 (2026-05-07): Tenant.tenantSeq + 管理テナント対応の準備
--
-- 目的:
--   - 顧客向け人間可読連番 (案 D) の実装
--   - default-tenant=1、新規顧客は SEQUENCE で 2, 3, 4, ...、管理テナントは null
--
-- 詳細仕様: docs/roadmap/ROLE_REFACTORING_PLAN.md §2.3-bis
--
-- 重要: User.systemRole は VarChar(20) のまま (列定義変更なし)。
--   許容値に 'super_admin' が追加されるが、application 層の zod validator で表現する
--   ため DB スキーマには変更不要。

-- 1. tenant_seq カラムを追加 (Int, nullable, unique)
ALTER TABLE "tenants" ADD COLUMN "tenant_seq" INTEGER;

-- partial unique index (NULL 同士は衝突しないが、念のため明示)
CREATE UNIQUE INDEX "tenants_tenant_seq_key" ON "tenants" ("tenant_seq")
  WHERE "tenant_seq" IS NOT NULL;

-- 2. SEQUENCE を作成 (新規テナント追加時に auto-increment)
--    START WITH 2: 1 は default-tenant に固定 seed されているため
CREATE SEQUENCE "tenants_tenant_seq_seq" START WITH 2;
ALTER TABLE "tenants" ALTER COLUMN "tenant_seq" SET DEFAULT nextval('tenants_tenant_seq_seq');

-- 3. 既存 default-tenant に tenant_seq=1 を固定 seed
--    SEQUENCE の値より小さい固定値なので、自動採番との衝突なし
UPDATE "tenants"
  SET "tenant_seq" = 1
  WHERE id = '00000000-0000-0000-0000-000000000001'::uuid
    AND "tenant_seq" IS NULL;
