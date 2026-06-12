-- ADR-0036: システム周知バナー (画面上部の帯メッセージ) テーブルを追加する。
--
-- 設計:
--   - **グローバル** (tenant_id を持たない): 運営者 (super_admin) の運用周知。全テナントの
--     全ログインユーザに同一の帯を表示する。tenant スコープではないため [ADR-0024] の
--     「tenant_id に DEFAULT を付けない」原則は対象外 (tenant_id カラム自体が無い)。
--   - **severity**: 'high' | 'medium' | 'low' (高=赤 / 中=黄 / 低=青)。値の正本は
--     src/lib/validators/system-banner.ts の BANNER_SEVERITIES。CHECK は付けず service/zod で担保。
--   - **created_by**: 払い出した super_admin の User.id。tenants.created_by_user_id と同じ設計で
--     FK にしない (User 物理削除で宙吊りになっても履歴上の事実として問題ない)。
--   - **index**: 表示判定 (getActiveBanner: enabled AND start_at<=now<end_at) と重複判定
--     (assertNoOverlap) の hot path 用に (enabled, start_at, end_at) の複合 index を貼る。
--
-- ロールバック: DROP TABLE "system_banners";

CREATE TABLE "system_banners" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "message"    VARCHAR(500) NOT NULL,
  "severity"   VARCHAR(10)  NOT NULL,
  "start_at"   TIMESTAMPTZ  NOT NULL,
  "end_at"     TIMESTAMPTZ  NOT NULL,
  "enabled"    BOOLEAN      NOT NULL DEFAULT true,
  "created_by" UUID         NOT NULL,
  "created_at" TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ  NOT NULL,
  CONSTRAINT "system_banners_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_system_banners_active"
  ON "system_banners" ("enabled", "start_at", "end_at");
