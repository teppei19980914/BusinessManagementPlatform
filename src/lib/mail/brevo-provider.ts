import type { MailProvider, MailParams, MailResult } from './mail-provider';
import { recordError, logUnknownError } from '@/services/error-log.service';

/**
 * Brevo（旧Sendinblue）トランザクションメール送信プロバイダ
 * 公式API: https://developers.brevo.com/docs/send-a-transactional-email
 *
 * PR #115 (2026-04-24): console.* を全て system_error_logs に切替。
 */
export class BrevoMailProvider implements MailProvider {
  private apiKey: string;
  private senderEmail: string;
  private senderName: string;

  constructor() {
    this.apiKey = process.env.BREVO_API_KEY || '';
    this.senderEmail = process.env.MAIL_FROM || 'noreply@example.com';
    this.senderName = process.env.MAIL_FROM_NAME || 'たすきば';

    if (!this.apiKey) {
      void recordError({
        severity: 'warn',
        source: 'mail',
        message: '[BrevoMailProvider] BREVO_API_KEY が未設定です',
      });
    }
  }

  async send(params: MailParams): Promise<MailResult> {
    if (!this.apiKey) {
      await recordError({
        severity: 'error',
        source: 'mail',
        message: '[BrevoMailProvider] BREVO_API_KEY が未設定のためスキップ',
      });
      return { success: false, error: 'BREVO_API_KEY is not configured' };
    }

    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': this.apiKey,
        },
        body: JSON.stringify({
          sender: { name: this.senderName, email: this.senderEmail },
          to: [{ email: params.to }],
          subject: params.subject,
          htmlContent: params.html,
          ...(params.text ? { textContent: params.text } : {}),
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        await recordError({
          severity: 'error',
          source: 'mail',
          message: `[BrevoMailProvider] 送信失敗 (${res.status})`,
          context: { status: res.status, responseText: errorText.slice(0, 500) },
        });
        return { success: false, error: errorText };
      }

      const data = await res.json();
      await recordError({
        severity: 'info',
        source: 'mail',
        message: '[BrevoMailProvider] 送信成功',
        context: { messageId: data.messageId, to: params.to },
      });
      return { success: true, messageId: data.messageId };
    } catch (e) {
      await logUnknownError('mail', e, {
        context: { provider: 'brevo', to: params.to },
      });
      return { success: false, error: String(e) };
    }
  }
}
