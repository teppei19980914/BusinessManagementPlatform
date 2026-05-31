-- security/phase-4 (2026-05-31): audit_logs / auth_event_logs を DB レベルで UPDATE block
--
-- 背景:
--   アプリ層 (src/services/audit.service.ts / src/services/auth-event.service.ts) は INSERT 専用設計で、
--   UPDATE / DELETE を呼ぶ関数自体を export していない。しかし Prisma client が直接 prisma.auditLog.update()
--   等を呼ぶことを構造的に防ぐ仕組みは無く、SOC 2 / ISO 27001 / J-SOX 等の監査ログ改ざん耐性要件
--   (immutable audit trail) を DB レベルで保証する必要がある。
--
-- 設計判断:
--   - **UPDATE のみ block**: 改ざんの主防御。UPDATE は cascade で発火しないため、ブロックしても
--     既存運用に影響しない (アプリ層からの直接 UPDATE が想定されていない設計の物理化)。
--   - **DELETE は素通り**: cascade DELETE (テナント物理削除 → audit_logs/auth_event_logs に
--     ON DELETE CASCADE で連鎖) で発火するため、ブロックすると tenant.delete() / user.delete() 等の
--     既存テナント物理削除フロー (super-admin.service.ts:deleteTenant / purgeExpiredBeginnerTenants) が
--     デッドロックする。直接 DELETE 防止はアプリ層の規律 (recordAuditLog しか export しない) で担保。
--
-- 確認:
--   - `grep -r 'prisma\.\(auditLog\|authEventLog\)\.\(update\|delete\|deleteMany\|updateMany\)' src/`
--     でアプリコード上の UPDATE/DELETE 呼出は 0 件 (generated/prisma/models の型定義のみ) を確認済。
--   - 本トリガ追加でアプリ層からの正常動作には一切影響しない。

CREATE OR REPLACE FUNCTION prevent_audit_log_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit log tables are append-only (security/phase-4): UPDATE blocked on % row', TG_TABLE_NAME
    USING ERRCODE = 'P0001', HINT = 'Audit log integrity is enforced at DB level. INSERT-only via app layer (recordAuditLog / recordAuthEvent).';
END;
$$;

-- audit_logs テーブル UPDATE block
DROP TRIGGER IF EXISTS prevent_audit_logs_update ON audit_logs;
CREATE TRIGGER prevent_audit_logs_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_update();

-- auth_event_logs テーブル UPDATE block
DROP TRIGGER IF EXISTS prevent_auth_event_logs_update ON auth_event_logs;
CREATE TRIGGER prevent_auth_event_logs_update
  BEFORE UPDATE ON auth_event_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_update();
