import type { MailProvider, MailParams, MailResult } from './mail-provider';
import { recordError, logUnknownError } from '@/services/error-log.service';

/**
 * PR #115 (2026-04-24): 旧実装は console.warn / console.error / console.log を直接使っていたが、
 * 機密情報 (API key の有無、送信先メール、エラー詳細) が Console に出るため、
 * 全て system_error_logs 経由に切替。
 */
export class ResendMailProvider implements MailProvider {
  private apiKey: string;
  private from: string;

  constructor() {
    this.apiKey = process.env.RESEND_API_KEY || '';
    this.from = process.env.MAIL_FROM || 'onboarding@resend.dev';

    if (!this.apiKey) {
      void recordError({
        severity: 'warn',
        source: 'mail',
        message: '[ResendMailProvider] RESEND_API_KEY が未設定です',
      });
    }
  }

  async send(params: MailParams): Promise<MailResult> {
    if (!this.apiKey) {
      await recordError({
        severity: 'error',
        source: 'mail',
        message: '[ResendMailProvider] RESEND_API_KEY が未設定のためスキップ',
      });
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
        await recordError({
          severity: 'error',
          source: 'mail',
          message: `[ResendMailProvider] 送信失敗 (${res.status})`,
          context: { status: res.status, responseText: errorText.slice(0, 500) },
        });
        return { success: false, error: errorText };
      }

      const data = await res.json();
      await recordError({
        severity: 'info',
        source: 'mail',
        message: '[ResendMailProvider] 送信成功',
        context: { messageId: data.id, to: params.to },
      });
      return { success: true, messageId: data.id };
    } catch (e) {
      await logUnknownError('mail', e, {
        context: { provider: 'resend', to: params.to },
      });
      return { success: false, error: String(e) };
    }
  }
}
