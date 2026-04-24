import type { MailProvider, MailParams, MailResult } from './mail-provider';
import { recordError } from '@/services/error-log.service';

/**
 * デバッグ用メールプロバイダ。
 *
 * PR #115 (2026-04-24) 以降: 送信内容は system_error_logs に severity='info' で
 * 蓄積する方針に変更。名前は「Console」のままだが、実際には DB に保存される。
 * 理由: Console 出力は機密情報 (宛先メール・本文の一部) を外部に晒す可能性があり、
 * 本プロダクトのセキュリティ原則 (DESIGN §9.8.5) に反するため。
 *
 * 開発時に送信内容を確認したい場合は:
 *   - MAIL_PROVIDER=inbox (INBOX_DIR に JSON 書き出し、E2E 用) を使う
 *   - または DB の system_error_logs を直接参照する (`source='mail'`, `severity='info'`)
 */
export class ConsoleMailProvider implements MailProvider {
  async send(params: MailParams): Promise<MailResult> {
    await recordError({
      severity: 'info',
      source: 'mail',
      message: '[ConsoleMailProvider] 送信シミュレーション',
      context: {
        to: params.to,
        subject: params.subject,
        htmlPreview: params.html.slice(0, 200),
      },
    });
    return { success: true, messageId: `console-${Date.now()}` };
  }
}
