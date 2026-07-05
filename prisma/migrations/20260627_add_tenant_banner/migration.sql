-- ADR-0037: テナントバナー (テナント管理者が自テナント内のみに表示する帯メッセージ)
-- SystemBanner (全テナント共通) のテナントスコープ版として新設。
-- テナント分離: tenant_id を持ち、自テナントのユーザにのみ表示。他テナントからは読み書き不可。
-- 1 本制約: 同一テナント内で enabled なバナーの表示期間は重複不可 (service の assertNoOverlap)。

CREATE TABLE "tenant_banners" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"  UUID         NOT NULL,
    "message"    VARCHAR(500) NOT NULL,
    "severity"   VARCHAR(10)  NOT NULL,
    "start_at"   TIMESTAMPTZ  NOT NULL,
    "end_at"     TIMESTAMPTZ  NOT NULL,
    "enabled"    BOOLEAN      NOT NULL DEFAULT true,
    "created_by" UUID         NOT NULL,
    "created_at" TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "tenant_banners_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_banners_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 表示判定 (getActiveTenantBanner) と重複判定 (assertNoOverlap) の hot path 用複合 index
CREATE INDEX "idx_tenant_banners_active"
    ON "tenant_banners" ("tenant_id", "enabled", "start_at", "end_at");
