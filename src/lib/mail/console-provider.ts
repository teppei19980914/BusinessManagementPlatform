import type { MailProvider, MailParams, MailResult } from './mail-provider';

export class ConsoleMailProvider implements MailProvider {
  async send(params: MailParams): Promise<MailResult> {
    console.log('=== メール送信（コンソール出力） ===');
    console.log(`To: ${params.to}`);
    console.log(`Subject: ${params.subject}`);
    console.log(`HTML: ${params.html.slice(0, 200)}...`);
    console.log('================================');
    return { success: true, messageId: `console-${Date.now()}` };
  }
}
