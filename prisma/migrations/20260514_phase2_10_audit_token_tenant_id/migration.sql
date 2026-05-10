-- 2026-05-10 Phase 2-10: 監査・トークン系テーブルへの tenantId 列追加 (severity-1 構造的脆弱性解消)
--
-- 背景:
--   Phase 1〜2-9 (PR #297〜#306) で全 business entity のテナント越境を遮断したが、
--   下記テーブルは schema 上 tenantId 列が存在せず、userId 経由でしか暗黙的にしか
--   テナントを推測できないため、**構造的脆弱性**として残されていた。
--
--   - audit_logs                  (監査ログ)
--   - role_change_logs            (権限変更ログ)
--   - auth_event_logs             (認証イベント。pre-auth は userId NULL のため tenantId も NULL 許容)
--   - email_verification_tokens   (メール検証 / 招待 トークン)
--   - password_reset_tokens       (PW リセットトークン)
--   - recovery_codes              (リカバリコード)
--   - password_histories          (PW 履歴)
--
-- 攻撃シナリオ (本マイグレーション以前):
--   - tokenHash 漏洩時に他テナント user の検証画面で再利用可能 (越境アカウント乗っ取り)
--   - User 物理削除後の AuditLog は user JOIN で tenantId 不明になる宙ぶらりんログ
--
-- 対策:
--   1. tenant_id 列追加 (NOT NULL、AuthEventLog のみ NULL 許容: pre-auth 失敗時)
--   2. 既存行は users.tenant_id を JOIN で backfill
--   3. tenants(id) への FK 追加
--   4. (tenant_id, created_at DESC) インデックス追加 (admin 画面の自テナント絞込み高速化)
--
-- べき等性:
--   - ADD COLUMN IF NOT EXISTS で再実行安全
--   - UPDATE は WHERE tenant_id IS NULL で再実行時 NO-OP
--   - ALTER COLUMN ... SET NOT NULL は再実行時 NO-OP (既に NOT NULL なら無視)
--   - FK 追加は DO ブロック + duplicate_object 例外で idempotent
--
-- 関連: docs/security/TENANT_ISOLATION_PHASE2_TODO.md Phase 2-10 章

-- =====================================================================
-- 1. audit_logs に tenant_id を追加
-- =====================================================================

ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

UPDATE "audit_logs" al
   SET "tenant_id" = u."tenant_id"
  FROM "users" u
 WHERE al."user_id" = u."id"
   AND al."tenant_id" IS NULL;

ALTER TABLE "audit_logs"
  ALTER COLUMN "tenant_id" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON UPDATE CASCADE ON DELETE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_audit_tenant"
  ON "audit_logs" ("tenant_id", "created_at" DESC);

COMMENT ON COLUMN "audit_logs"."tenant_id" IS 'Phase 2-10: 監査ログのテナント帰属を直接保持 (User join 経由ではなく直接フィルタ可能)';

-- =====================================================================
-- 2. role_change_logs に tenant_id を追加
-- =====================================================================

ALTER TABLE "role_change_logs"
  ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

UPDATE "role_change_logs" rcl
   SET "tenant_id" = u."tenant_id"
  FROM "users" u
 WHERE rcl."target_user_id" = u."id"
   AND rcl."tenant_id" IS NULL;

ALTER TABLE "role_change_logs"
  ALTER COLUMN "tenant_id" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "role_change_logs"
    ADD CONSTRAINT "role_change_logs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON UPDATE CASCADE ON DELETE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_role_change_logs_tenant"
  ON "role_change_logs" ("tenant_id", "created_at" DESC);

COMMENT ON COLUMN "role_change_logs"."tenant_id" IS 'Phase 2-10: 権限変更ログのテナント帰属 (target user の tenant)';

-- =====================================================================
-- 3. auth_event_logs に tenant_id を追加 (pre-auth 失敗で userId NULL のため NULL 許容)
-- =====================================================================

ALTER TABLE "auth_event_logs"
  ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

UPDATE "auth_event_logs" ael
   SET "tenant_id" = u."tenant_id"
  FROM "users" u
 WHERE ael."user_id" = u."id"
   AND ael."tenant_id" IS NULL
   AND ael."user_id" IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE "auth_event_logs"
    ADD CONSTRAINT "auth_event_logs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON UPDATE CASCADE ON DELETE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_auth_events_tenant"
  ON "auth_event_logs" ("tenant_id", "created_at" DESC);

COMMENT ON COLUMN "auth_event_logs"."tenant_id" IS 'Phase 2-10: 認証イベントのテナント帰属 (pre-auth 失敗で user_id 不明時は NULL)';

-- =====================================================================
-- 4. email_verification_tokens に tenant_id を追加
-- =====================================================================

ALTER TABLE "email_verification_tokens"
  ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

UPDATE "email_verification_tokens" evt
   SET "tenant_id" = u."tenant_id"
  FROM "users" u
 WHERE evt."user_id" = u."id"
   AND evt."tenant_id" IS NULL;

ALTER TABLE "email_verification_tokens"
  ALTER COLUMN "tenant_id" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "email_verification_tokens"
    ADD CONSTRAINT "email_verification_tokens_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON UPDATE CASCADE ON DELETE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_email_verification_tokens_tenant"
  ON "email_verification_tokens" ("tenant_id");

COMMENT ON COLUMN "email_verification_tokens"."tenant_id" IS 'Phase 2-10: 検証 token のテナント帰属 (token 漏洩時の越境再利用遮断)';

-- =====================================================================
-- 5. password_reset_tokens に tenant_id を追加
-- =====================================================================

ALTER TABLE "password_reset_tokens"
  ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

UPDATE "password_reset_tokens" prt
   SET "tenant_id" = u."tenant_id"
  FROM "users" u
 WHERE prt."user_id" = u."id"
   AND prt."tenant_id" IS NULL;

ALTER TABLE "password_reset_tokens"
  ALTER COLUMN "tenant_id" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON UPDATE CASCADE ON DELETE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_password_reset_tokens_tenant"
  ON "password_reset_tokens" ("tenant_id");

COMMENT ON COLUMN "password_reset_tokens"."tenant_id" IS 'Phase 2-10: PW リセット token のテナント帰属';

-- =====================================================================
-- 6. recovery_codes に tenant_id を追加
-- =====================================================================

ALTER TABLE "recovery_codes"
  ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

UPDATE "recovery_codes" rc
   SET "tenant_id" = u."tenant_id"
  FROM "users" u
 WHERE rc."user_id" = u."id"
   AND rc."tenant_id" IS NULL;

ALTER TABLE "recovery_codes"
  ALTER COLUMN "tenant_id" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "recovery_codes"
    ADD CONSTRAINT "recovery_codes_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON UPDATE CASCADE ON DELETE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_recovery_codes_tenant"
  ON "recovery_codes" ("tenant_id");

COMMENT ON COLUMN "recovery_codes"."tenant_id" IS 'Phase 2-10: リカバリコードのテナント帰属';

-- =====================================================================
-- 7. password_histories に tenant_id を追加
-- =====================================================================

ALTER TABLE "password_histories"
  ADD COLUMN IF NOT EXISTS "tenant_id" UUID;

UPDATE "password_histories" ph
   SET "tenant_id" = u."tenant_id"
  FROM "users" u
 WHERE ph."user_id" = u."id"
   AND ph."tenant_id" IS NULL;

ALTER TABLE "password_histories"
  ALTER COLUMN "tenant_id" SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE "password_histories"
    ADD CONSTRAINT "password_histories_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON UPDATE CASCADE ON DELETE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_password_histories_tenant"
  ON "password_histories" ("tenant_id");

COMMENT ON COLUMN "password_histories"."tenant_id" IS 'Phase 2-10: PW 履歴のテナント帰属';
