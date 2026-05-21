-- Rollback for 20260526_tenant_consent_log
--
-- ⚠️ 本テーブルは法的証跡 (規約・プラポリ同意ログ) を保存します。
--   ロールバック実行前に必ず以下を確認してください:
--     1. 既存レコードを CSV エクスポートして docs/operations/legal-archive/ に保管
--     2. 5 年間 (商法 19 条 / 個人情報保護法 26 条) の保管義務に抵触しないこと
--     3. 業務影響範囲 (signup API が 500 エラーになる) を super_admin と協議
--
--   緊急時を除き、ロールバックよりも前方修正を優先してください。

DROP INDEX IF EXISTS "idx_tenant_consent_logs_tenant";
DROP TABLE IF EXISTS "tenant_consent_logs";
