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

-- Step 4: backfill 後の NULL 残置検知 (= 運用 visibility)
--   既存テナントに admin/super_admin (deletedAt=null) が 1 人もいない場合、Step 2 の subquery が NULL を返し
--   created_by_user_id が NULL のまま残る。このとき層 1 判定が silent fail し、当該テナントの過去 admin email で
--   公開 /signup を試した user に Expert/Pro 自己発行を許す soft relaxation が発生する。
--   migration 実行ログに NOTICE を残し、運用者が手動修正できるようにする。
--   (= 完全自動修復は不可能。general user のみのテナントを「誰が払い出したか」DB から判別不能のため。)
DO $$
DECLARE
  null_count INT;
BEGIN
  SELECT COUNT(*) INTO null_count
  FROM "tenants"
  WHERE "created_by_user_id" IS NULL
    AND "deleted_at" IS NULL;
  IF null_count > 0 THEN
    RAISE WARNING
      'ADR-0016 Revised backfill: created_by_user_id が NULL のまま残った tenant が % 件あります。'
      ' 当該テナントは admin/super_admin (deletedAt=null) を持たない可能性があります。'
      ' 層 1 判定の整合性確保のため、手動で UPDATE tenants SET created_by_user_id = <該当 user.id> を実施してください。'
      ' 該当 tenant 一覧: SELECT id, slug FROM tenants WHERE created_by_user_id IS NULL AND deleted_at IS NULL;',
      null_count;
  END IF;
END $$;
