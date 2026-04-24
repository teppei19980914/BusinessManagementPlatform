import type { MailProvider } from './mail-provider';
import { ConsoleMailProvider } from './console-provider';
import { ResendMailProvider } from './resend-provider';
import { BrevoMailProvider } from './brevo-provider';
import { InboxMailProvider } from './inbox-provider';
import { recordError } from '@/services/error-log.service';

export type { MailProvider, MailParams, MailResult } from './mail-provider';

/**
 * PR #115 (2026-04-24): console.warn を全て system_error_logs に切替。
 * provider 選択の失敗 / フォールバックは DB に残す。
 */
export function createMailProvider(): MailProvider {
  const provider = process.env.MAIL_PROVIDER || 'console';
  switch (provider) {
    case 'brevo':
      if (!process.env.BREVO_API_KEY) {
        void recordError({
          severity: 'warn',
          source: 'mail',
          message: '[MailProvider] MAIL_PROVIDER=brevo ですが BREVO_API_KEY が未設定。console にフォールバック',
        });
        return new ConsoleMailProvider();
      }
      return new BrevoMailProvider();
    case 'resend':
      if (!process.env.RESEND_API_KEY) {
        void recordError({
          severity: 'warn',
          source: 'mail',
          message: '[MailProvider] MAIL_PROVIDER=resend ですが RESEND_API_KEY が未設定。console にフォールバック',
        });
        return new ConsoleMailProvider();
      }
      return new ResendMailProvider();
    case 'inbox': {
      // PR #92: E2E 専用。INBOX_DIR に JSON を書き出す。本番では指定しないこと。
      const dir = process.env.INBOX_DIR;
      if (!dir) {
        void recordError({
          severity: 'warn',
          source: 'mail',
          message: '[MailProvider] MAIL_PROVIDER=inbox ですが INBOX_DIR が未設定。console にフォールバック',
        });
        return new ConsoleMailProvider();
      }
      return new InboxMailProvider(dir);
    }
    case 'console':
    default:
      return new ConsoleMailProvider();
  }
}

// シングルトン
let mailProvider: MailProvider | null = null;

export function getMailProvider(): MailProvider {
  if (!mailProvider) {
    mailProvider = createMailProvider();
  }
  return mailProvider;
}
