-- P-H (2026-05-08): EmailSendLog テーブルを追加
--
-- 目的:
--   Brevo 等の無料プロバイダの送信上限 (Brevo: 300 通/日) 超過事故を未然に検知。
--   getMailProvider().send() の全送信を log に記録し、super_admin ダッシュボードで
--   日次/月次の件数を可視化、80%/90% で警告色変化させる。
--
-- 詳細仕様: docs/roadmap/V1_FINAL_TASKS.md P-H
-- 関連: src/services/email-send-log.service.ts (記録 + 集計)

CREATE TABLE "email_send_logs" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"        UUID,
    "type"             VARCHAR(40) NOT NULL,
    "recipient_hash"   VARCHAR(64) NOT NULL,
    "recipient_domain" VARCHAR(255) NOT NULL,
    "success"          BOOLEAN NOT NULL,
    "error_message"    TEXT,
    "provider_name"    VARCHAR(20) NOT NULL,
    "sent_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "email_send_logs_pkey" PRIMARY KEY ("id")
);

-- 日次 / 月次集計用 index (super_admin ダッシュボードのリアルタイム集計を高速化)
CREATE INDEX "idx_email_send_logs_sent_at"
  ON "email_send_logs" ("sent_at" DESC);

-- 種別 + 期間 集計用 (cron 経由通知 vs 招待メール 等の比率把握)
CREATE INDEX "idx_email_send_logs_type"
  ON "email_send_logs" ("type", "sent_at" DESC);
