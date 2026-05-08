-- P-G (2026-05-08): Tenant に請求先情報フィールドを追加
--
-- 目的:
--   super_admin の請求業務 (CSV エクスポート / 請求書手作成) で必要な
--   請求先情報を Tenant に直接持たせる。1:1 関係 + 操作頻度低 + JOIN 回避のため
--   別テーブル化はしない。
--
-- 既存テナント (default-tenant / management) は null のまま (運営内部のため請求対象外)。
-- 新規顧客テナント (super_admin 作成 API + /signup) はアプリ層で必須 4 項目を validate する。
--
-- 詳細仕様: docs/roadmap/V1_FINAL_TASKS.md P-G

ALTER TABLE "tenants"
  ADD COLUMN "billing_company_name"  VARCHAR(200),
  ADD COLUMN "billing_contact_name"  VARCHAR(100),
  ADD COLUMN "billing_contact_email" VARCHAR(255),
  ADD COLUMN "billing_address"       TEXT,
  ADD COLUMN "billing_phone_number"  VARCHAR(20),
  ADD COLUMN "payment_method"        VARCHAR(30) NOT NULL DEFAULT 'invoice';
