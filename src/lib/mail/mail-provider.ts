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
   *
   * 2026-05-12: Beginner プラン Day 180 自動物理削除に向けた事前通知を追加
   *   - beginner_auto_delete_warning_150: テナント作成から 150 日 (= 自動削除 30 日前)
   *   - beginner_auto_delete_warning_170: テナント作成から 170 日 (= 自動削除 10 日前)
   *   email_send_logs.type 列 (text) はサービス側で値を組み立てるため DB 制約変更不要。
   *
   * 2026-05-19 (PR-V7a): super_admin 向けの運用 alert (= 期日超過 / cron 失敗 / 金額乖離 等)
   *   - admin_alert: src/services/admin-alert.service.ts sendSuperAdminAlert 経由送信
   */
  type?:
    | 'invitation'
    | 'password_reset'
    | 'usage_alert'
    | 'beginner_warning_60'
    | 'beginner_warning_75'
    | 'beginner_expired'
    | 'beginner_auto_delete_warning_150'
    | 'beginner_auto_delete_warning_170'
    | 'admin_alert'
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
