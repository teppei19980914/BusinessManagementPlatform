-- ADR-0016 Revised (2026-05-22): テナント払い出し時の初期 admin User.id を Tenant に保持
--
-- 目的:
--   公開セルフサインアップ (/api/auth/signup) の「自前テナント保有」3 層判定 (層 1) を実装する。
--   旧設計 (ADR-0016 オリジナル / 2026-05-20): tenants.billing_contact_email / users.email の
--   4 条件 OR 判定で「過去/現在を問わず登録履歴あり」を判定 → 「Beginner 不可」とのみ振り分けていた。
--   新設計 (ADR-0016 Revised / 2026-05-22): 初期 admin 判定キーを `initialAdminEmail` 1 本に絞り、
--   `tenants.created_by_user_id` の所属で「自前テナント保有」(= 公開フォーム完全不可、admin 問合せ
--   必須) を識別する。
--
-- 設計:
--   - NULLABLE: 既存テナントへの backfill が万一漏れても silent fail させない安全マージン。
--     新規テナント作成は onboarding service が必ずセットするため運用上は実質 NOT NULL。
--   - User.id への FK にしない: suspendedBy と同じ設計 (= User 物理削除時に宙吊りになっても
--     「過去にこの user が払い出した」という事実は判定に支障なし)。
--   - index: 3 層判定の hot path クエリ `WHERE created_by_user_id IN (user.id) ` で使うため
--     btree index を追加。NULL を除外するため partial index 化。
--
-- 本番 DB 事前確認 (2026-05-22 想定):
--   - 既存テナント: MANAGEMENT + Default の 2 件
--   - MANAGEMENT: super_admin (admin@knowledge-relay-platform.admin) が初期 admin
--   - Default: 須山哲平 (teppei_suyama@softec-ic.co.jp) が初期 admin
--
-- backfill ロジック:
--   各テナントの systemRole='admin' な user の中で createdAt が最古の user を初期 admin とみなす。
--   v1 ローンチ前 (2026-06-01 リリース予定) の現時点では複雑な権限変更履歴は無いため、この
--   推定で正確に「テナント作成者」を特定可能。
--
-- ロールバック:
--   万一問題発生時、本ファイルの逆 SQL を rollback.sql に記録。

-- Step 1: 列追加
ALTER TABLE "tenants"
  ADD COLUMN "created_by_user_id" UUID;

-- Step 2: backfill — 各テナントの最古 admin / super_admin user を created_by_user_id にセット
--   注 1: 管理テナント (MANAGEMENT) は systemRole='super_admin' のため、
--         'admin' だけだと NULL のまま残る。'super_admin' を含めることで管理テナントも対象化。
--   注 2: deleted_at IS NULL を必須にする。削除済みユーザを「初期 admin」と推定してしまうと、
--         層 1 判定の参照先が削除済 user.id になり「users.email = X」クエリでヒットしない →
--         実質的に「自前テナント保有」が誤って解除される silent fail に直結する。
UPDATE "tenants" t
SET "created_by_user_id" = (
  SELECT u.id
  FROM "users" u
  WHERE u.tenant_id = t.id
    AND u.system_role IN ('admin', 'super_admin')
    AND u.deleted_at IS NULL
  ORDER BY u.created_at ASC
  LIMIT 1
)
WHERE t.created_by_user_id IS NULL;

-- Step 3: 3 層判定の hot path 用 partial index (NULL を除外してサイズ最小化)
CREATE INDEX "idx_tenants_created_by_user_id_partial"
  ON "tenants" ("created_by_user_id")
  WHERE "created_by_user_id" IS NOT NULL;
