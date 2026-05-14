-- Tenant read-only 強制移行機能 (2026-05-14, PR #372)
--
-- 役割:
--   super_admin が支払い滞納等で任意のテナントを read-only (= write 系 HTTP method 403) にするための
--   専用フラグ。書き込み禁止だが閲覧・エクスポート・self-delete・プラン変更は引き続き可能。
--
-- 設計:
--   - suspendedAt が null でない間 = read-only モード
--   - suspendReason に文字列コード (例 'payment_delinquent', 'tos_violation', 'other')
--   - suspendedBy に実行 super_admin の User.id (参照しやすさのため Tenant 本体にも保持。
--     詳細監査は audit_logs に別途 INSERT)
--   - resumedAt は直近の解除時刻。suspendedAt=null かつ resumedAt!=null = 過去に停止 → 解除済
--   - middleware (auth.config.ts) は JWT claim tenantSuspendedAt を参照して write 系を遮断
--
-- 影響:
--   - 既存テナントは全て suspendedAt=NULL で開始 (= 通常運用)
--   - NULLABLE のため backfill 不要
--   - suspendedBy は User.id への FK にしない (= super_admin の userId は監査ログ用、テナント側で
--     強い整合性は求めない。User 削除時に suspendedBy が宙吊りになっても read-only 解除に支障なし)

ALTER TABLE "tenants"
  ADD COLUMN "suspended_at"    TIMESTAMPTZ,
  ADD COLUMN "suspend_reason"  VARCHAR(50),
  ADD COLUMN "suspended_by"    UUID,
  ADD COLUMN "resumed_at"      TIMESTAMPTZ;

-- suspended_at に部分インデックス (= 停止中テナントの一覧クエリ用、99% は NULL なので
-- WHERE suspended_at IS NOT NULL の部分インデックスでサイズ最小化)
CREATE INDEX "idx_tenants_suspended_at_partial"
  ON "tenants" ("suspended_at")
  WHERE "suspended_at" IS NOT NULL;
