-- PR-V7a (2026-05-19): 請求業務の横展開実装に伴う BillingHistory 拡張
--
-- 目的:
--   1. invoice (銀行振込) の支払期日管理 + 期日超過 alert (= B-3)
--   2. credit_card Smart Retries の次回試行日表示 (= C-1)
--   3. super_admin による手動消込の操作監査 (= A-1)
--
-- 設計判断:
--   - 全カラム NULLABLE (= 既存レコードに影響なし)
--   - paymentDueDate は導出可能だが、cron での絞り込み index 用に保存
--   - confirmedBy は AuditLog にも記録、こちらは BillingHistory 詳細画面の表示用
--
-- 関連:
--   - 仕様: docs/business/STRIPE_BILLING.md
--   - 定数: src/config/billing.ts
--   - API:  src/app/api/admin/super/billing/[id]/confirm-payment/route.ts (新規)

ALTER TABLE "billing_history"
  ADD COLUMN "payment_due_date"       TIMESTAMPTZ,
  ADD COLUMN "overdue_alert_sent_at"  TIMESTAMPTZ,
  ADD COLUMN "next_payment_attempt"   TIMESTAMPTZ,
  ADD COLUMN "confirmed_by"           UUID,
  ADD COLUMN "confirmed_at"           TIMESTAMPTZ;

-- 期日超過検知 cron で使用 (pending status のレコードを期日順に走査)
CREATE INDEX "idx_billing_history_due_date"
  ON "billing_history" ("payment_due_date", "status");
