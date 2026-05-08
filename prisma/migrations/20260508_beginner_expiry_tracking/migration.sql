-- P-B (2026-05-08): Beginner プラン永続利用防止用の追跡フィールドを Tenant に追加
--
-- 目的:
--   - 60/75 日警告メールの重複送信防止
--   - 90 日 read-only 通知メールの送信記録
--   - 「一度でも上位プランに上がったテナントは Beginner に戻せない」フラグ
--
-- 既存テナント (default-tenant / management-tenant / 各顧客テナント) は migration 後 false
-- + null のまま。Beginner プランで運用中の既存テナントも createdAt 起点で判定が始まる。
--
-- 詳細仕様: docs/roadmap/V1_FINAL_TASKS.md P-B
-- 関連: src/services/beginner-expiry.service.ts (判定ヘルパ)

ALTER TABLE "tenants"
  ADD COLUMN "beginner_ever_upgraded"             BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN "beginner_notice_day60_sent_at"      TIMESTAMPTZ,
  ADD COLUMN "beginner_notice_day75_sent_at"      TIMESTAMPTZ,
  ADD COLUMN "beginner_expired_notice_sent_at"    TIMESTAMPTZ;
