import type { MailProvider, MailParams, MailResult } from './mail-provider';

export class ResendMailProvider implements MailProvider {
  private apiKey: string;
  private from: string;

  constructor() {
    this.apiKey = process.env.RESEND_API_KEY || '';
    this.from = process.env.MAIL_FROM || 'noreply@example.com';
  }

  async send(params: MailParams): Promise<MailResult> {
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
        const error = await res.text();
        return { success: false, error };
      }

      const data = await res.json();
      return { success: true, messageId: data.id };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }
}
