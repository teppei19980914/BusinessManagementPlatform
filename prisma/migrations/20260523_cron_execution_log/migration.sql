-- PR feat/cron-execution-log (2026-05-18)
--
-- 目的: cron 実行履歴を蓄積するテーブル。super_admin ダッシュボードからの可観測性確保 +
--       Netlify Functions 10 秒 timeout の検知に使用。
--
-- 設計判断:
--   - tenantId / userId を持たない (= cron は全テナント横断のシステム運用のため)
--   - completedAt=null + status='running' のレコード = 実行中または timeout
--   - payload_json は cron route が返す結果サマリをそのまま保存
--   - logging 失敗が cron 本体を fail させない設計のため、本テーブルへの書込みエラーは
--     呼出側で try/catch + console.warn で吸収する (アプリ側 helper にて実装)
--
-- 手動適用 (Supabase SQL Editor):
--   1. 本ファイル全体を SQL Editor に貼り付け → Run
--   2. 「Success」を確認
--   ロールバック: `DROP TABLE cron_execution_logs;`

CREATE TABLE cron_execution_logs (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name     VARCHAR(64)  NOT NULL,
  started_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  duration_ms   INTEGER,
  status        VARCHAR(20)  NOT NULL,         -- 'running' | 'success' | 'failure'
  error_message TEXT,
  error_stack   TEXT,
  payload_json  JSONB,
  invoker_ip    VARCHAR(45)                    -- IPv6 含む最大長 45 文字
);

-- 検索パターン別の index
CREATE INDEX idx_cron_exec_name_date   ON cron_execution_logs (cron_name, started_at DESC);
CREATE INDEX idx_cron_exec_status_date ON cron_execution_logs (status,    started_at DESC);
CREATE INDEX idx_cron_exec_date        ON cron_execution_logs (started_at DESC);
