-- PR #115 (2026-04-24): 内部エラー / クライアントエラーを蓄積する監査系テーブル
--
-- 設計方針 (DESIGN.md §9.8.5):
--   - ブラウザ Console / サーバ Console に機密情報 (設定値、スタック、SQL 内部情報) を
--     出さず、必ず本テーブルに保存してからユーザには固定文言を返す。
--   - AuditLog は userId NOT NULL で pre-auth エラーを扱えないため、
--     AuthEventLog と同じ「nullable userId + JSON detail」パターンを踏襲。
--
-- 手動適用 (Supabase SQL Editor):
--   このファイル全体を 1 トランザクション相当で実行。
--   ロールバックは `DROP TABLE system_error_logs;`

CREATE TABLE system_error_logs (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  severity    VARCHAR(10)  NOT NULL,          -- 'info' | 'warn' | 'error' | 'fatal'
  source      VARCHAR(30)  NOT NULL,          -- 'server' | 'client' | 'cron' | 'mail' 等
  message     TEXT         NOT NULL,
  stack       TEXT,
  user_id     UUID,                           -- pre-auth エラーや cron 起動分は NULL
  request_id  VARCHAR(64),
  context     JSONB,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_system_errors_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX idx_system_errors_severity ON system_error_logs (severity, created_at DESC);
CREATE INDEX idx_system_errors_source   ON system_error_logs (source,   created_at DESC);
CREATE INDEX idx_system_errors_user     ON system_error_logs (user_id,  created_at DESC);
CREATE INDEX idx_system_errors_date     ON system_error_logs (created_at DESC);
