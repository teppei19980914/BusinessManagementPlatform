-- G2-e-1 (2026-05-31): 初回ログイン (たすきば未利用) 判定の高速化
--
-- 背景:
--   auth.ts の authorize で「この email の過去 login_success が 0 件か」を毎ログイン時に
--   数える (isFirstTimeUser 判定 / 方針 II)。既存の auth_event_logs インデックスは
--   userId / eventType / tenantId 起点で、email 起点の検索がフルスキャンになるため
--   email + event_type の複合インデックスを追加する。
--
-- ロールバック方針: DROP INDEX は安全 (判定が遅くなるだけ)。

CREATE INDEX IF NOT EXISTS "idx_auth_events_email"
  ON "auth_event_logs"("email", "event_type");
