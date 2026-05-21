-- 2026-05-26 (feat/legal-pages-lp-integration):
-- 利用規約・プライバシーポリシーへの同意ログテーブルを新規作成。
--
-- 背景:
--   民法 548 条の 2 (定型約款の組入合意) を満たすため、テナント作成時に利用規約・
--   プライバシーポリシーへの同意を取得し、不可変ログとして保持する。
--   後日「同意していない」と争われた際の証跡となる。
--
-- 同意取得経路:
--   /api/auth/signup → tenant-onboarding.service.createTenantBySignup() で
--   1 トランザクション内に Tenant + User + TenantConsentLog × 2 (terms/privacy) を作成。
--
-- 設計:
--   - tenant_id + consent_type + version の UNIQUE で再同意の重複防止
--   - accepted_at は immutable (アプリ層で UPDATE を禁止、論理削除のみ可)
--   - 規約・プラポリ本文は外部 LP (HomePage / tasukiba-user.md) に集約、
--     version は LP 側で管理 (本テーブルでは「いつ・どのバージョンに同意したか」のみ記録)
--
-- ロールバック: rollback.sql 参照

CREATE TABLE "tenant_consent_logs" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    UUID         NOT NULL,
  "user_id"      UUID         NOT NULL,
  "consent_type" VARCHAR(20)  NOT NULL,
  "version"      VARCHAR(20)  NOT NULL,
  "ip_address"   VARCHAR(45),
  "user_agent"   TEXT,
  "accepted_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT "tenant_consent_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_consent_logs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "tenant_consent_logs_unique_per_version"
    UNIQUE ("tenant_id", "consent_type", "version")
);

CREATE INDEX "idx_tenant_consent_logs_tenant"
  ON "tenant_consent_logs" ("tenant_id");
