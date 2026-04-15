/**
 * メール送信プロバイダ抽象インターフェース（設計書: DESIGN.md セクション 18.2）
 */

export type MailParams = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

export type MailResult = {
  success: boolean;
  messageId?: string;
  error?: string;
};

export interface MailProvider {
  send(params: MailParams): Promise<MailResult>;
}
