-- PR-1 (2026-05-15): timezone / locale をユーザ単位 (User.timezone/locale) から
-- テナント単位 (Tenant.timezone/locale) に集約する。
--
-- 背景:
--   - 同一テナント内でユーザごとに TZ/言語が異なると「使用量リセット日」「Beginner 残日数」
--     等のテナント全体の日付計算が崩れる
--   - テナント管理者がテナント全体の TZ を決め、配下ユーザは同じ表示で運用する方針
--
-- 戦略 (zero-downtime 不要、リリース前):
--   1. Tenant に timezone / locale 列を追加 (NOT NULL + default 'Asia/Tokyo' / 'ja-JP')
--   2. 既存テナントは default のまま (= 旧 user.timezone は数件 / 全テナント既定なので破棄して問題なし)
--   3. User から timezone / locale 列を drop
--
-- 関連:
--   - schema: prisma/schema.prisma の Tenant / User
--   - 旧 migration: 20260424_user_i18n_preferences (User に timezone/locale を追加)
--   - 設定 API: src/app/api/tenants/me/i18n/route.ts (新規)
--   - UI: src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx (新セクション)

-- Step 1: Tenant に timezone / locale 列を追加 (NOT NULL + default)
ALTER TABLE "tenants"
  ADD COLUMN "timezone" VARCHAR(60) NOT NULL DEFAULT 'Asia/Tokyo',
  ADD COLUMN "locale" VARCHAR(10) NOT NULL DEFAULT 'ja-JP';

-- Step 2: User の timezone / locale 列を drop (使用箇所はコード側でも撤去済み)
ALTER TABLE "users"
  DROP COLUMN "timezone",
  DROP COLUMN "locale";
