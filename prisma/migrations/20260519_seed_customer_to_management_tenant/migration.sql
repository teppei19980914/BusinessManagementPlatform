-- 2026-05-14: Customer シードデータの管理テナント移行 (#PR-customer-seed-sysadmin)
--
-- 経緯:
--   20260513_seed_to_management_tenant で is_sample_data=TRUE の Project / Knowledge /
--   RiskIssue / Retrospective を default-tenant から management-tenant へ移行したが、
--   親エンティティである Customer の移行が漏れていた。
--   結果: management-tenant の Project が default-tenant の Customer を customer_id で
--   参照する「テナント越境 FK」状態が継続。
--   - 機能影響: 提案エンジン (Project は cross-tenant 参照される) は customer 情報を
--     直接読まないので機能は壊れていないが、システム管理者画面で customer を CRUD
--     しようとすると management-tenant 側に該当 Customer が存在せず操作不能だった。
--   - 整合性: tenant 境界の不変条件 (1 リソースは 1 テナントに属する) を破る。
--
-- 移行内容:
--   管理テナントの is_sample_data=TRUE な Project が customer_id で参照している
--   Customer のうち、まだ default-tenant に残っているものを management-tenant へ移動。
--   参照されていない Customer (例: 手動作成された通常顧客) は対象外。
--
-- 冪等性:
--   - すでに management-tenant へ移行済の Customer は WHERE 条件で除外される (NO-OP)。
--   - 該当する customer_id が無い場合も UPDATE 0 行で安全に終了。

UPDATE "customers"
   SET "tenant_id" = '00000000-0000-0000-0000-ffffffffffff'::uuid
 WHERE "tenant_id" = '00000000-0000-0000-0000-000000000001'::uuid
   AND "id" IN (
     SELECT DISTINCT "customer_id"
       FROM "projects"
      WHERE "tenant_id" = '00000000-0000-0000-0000-ffffffffffff'::uuid
        AND "is_sample_data" = TRUE
        AND "customer_id" IS NOT NULL
   );
