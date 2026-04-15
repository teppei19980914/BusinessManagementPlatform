import type { MailProvider, MailParams, MailResult } from './mail-provider';

export class ResendMailProvider implements MailProvider {
  private apiKey: string;
  private from: string;

  constructor() {
    this.apiKey = process.env.RESEND_API_KEY || '';
    this.from = process.env.MAIL_FROM || 'onboarding@resend.dev';

    if (!this.apiKey) {
      console.warn('[ResendMailProvider] RESEND_API_KEY が未設定です。メール送信は失敗します。');
    }
  }

  async send(params: MailParams): Promise<MailResult> {
    if (!this.apiKey) {
      console.error('[ResendMailProvider] RESEND_API_KEY が未設定のためメール送信をスキップしました。');
      return { success: false, error: 'RESEND_API_KEY is not configured' };
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          from: this.from,
          to: params.to,
          subject: params.subject,
          html: params.html,
          text: params.text,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error(`[ResendMailProvider] 送信失敗 (${res.status}): ${errorText}`);
        return { success: false, error: errorText };
      }

      const data = await res.json();
      console.log(`[ResendMailProvider] 送信成功: ${data.id} → ${params.to}`);
      return { success: true, messageId: data.id };
    } catch (e) {
      console.error('[ResendMailProvider] 送信エラー:', e);
      return { success: false, error: String(e) };
    }
  }
}
