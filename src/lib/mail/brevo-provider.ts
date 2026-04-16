import type { MailProvider, MailParams, MailResult } from './mail-provider';

/**
 * Brevo（旧Sendinblue）トランザクションメール送信プロバイダ
 * 公式API: https://developers.brevo.com/docs/send-a-transactional-email
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
      console.warn('[BrevoMailProvider] BREVO_API_KEY が未設定です。メール送信は失敗します。');
    }
  }

  async send(params: MailParams): Promise<MailResult> {
    if (!this.apiKey) {
      console.error(
        '[BrevoMailProvider] BREVO_API_KEY が未設定のためメール送信をスキップしました。',
      );
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
        console.error(`[BrevoMailProvider] 送信失敗 (${res.status}): ${errorText}`);
        return { success: false, error: errorText };
      }

      const data = await res.json();
      console.log(`[BrevoMailProvider] 送信成功: ${data.messageId} → ${params.to}`);
      return { success: true, messageId: data.messageId };
    } catch (e) {
      console.error('[BrevoMailProvider] 送信エラー:', e);
      return { success: false, error: String(e) };
    }
  }
}
