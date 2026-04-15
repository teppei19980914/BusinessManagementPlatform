import type { MailProvider } from './mail-provider';
import { ConsoleMailProvider } from './console-provider';
import { ResendMailProvider } from './resend-provider';

export type { MailProvider, MailParams, MailResult } from './mail-provider';

export function createMailProvider(): MailProvider {
  const provider = process.env.MAIL_PROVIDER || 'console';
  switch (provider) {
    case 'resend':
      return new ResendMailProvider();
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
