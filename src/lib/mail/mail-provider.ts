/**
 * メール送信プロバイダ抽象インターフェース（設計書: DESIGN.md セクション 18.2）
 */

export type MailParams = {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /**
   * P-H (2026-05-08): 送信種別 (= ログ集計用ラベル)。指定されていれば
   * email_send_logs.type に記録される。未指定なら 'unknown' で記録。
   * 既存呼出は省略しても動作 (= 後方互換)。
   */
  type?:
    | 'invitation'
    | 'password_reset'
    | 'usage_alert'
    | 'beginner_warning_60'
    | 'beginner_warning_75'
    | 'beginner_expired'
    | 'unknown';
  /**
   * P-H (2026-05-08): 関連テナント ID (= ログの tenant_id 列に記録)。
   * cron 経由の system 通知では未指定 = null で記録。
   */
  tenantId?: string;
};

export type MailResult = {
  success: boolean;
  messageId?: string;
  error?: string;
};

export interface MailProvider {
  send(params: MailParams): Promise<MailResult>;
}
