/**
 * Inbox メールプロバイダ (PR #92 / E2E 専用)
 *
 * 役割:
 *   E2E テスト時、実際の外部メール送信を行わず、送信内容を JSON ファイルとして
 *   ディレクトリに書き出す。Playwright 側 (e2e/fixtures/inbox.ts) がこの
 *   ディレクトリを読み、トークン URL を抽出してシナリオを進める。
 *
 *   本番では使用されない (MAIL_PROVIDER=inbox を環境変数で指定した場合のみ起動)。
 *
 * 出力形式:
 *   INBOX_DIR で指定したディレクトリ配下に 1 通 1 ファイル (JSON):
 *     <timestamp>-<random>.json
 *   {
 *     "to": "...",
 *     "subject": "...",
 *     "html": "...",
 *     "text": "...",
 *     "receivedAt": "ISO8601"
 *   }
 *
 * 関連:
 *   - e2e/fixtures/inbox.ts: テスト側 reader
 *   - playwright.config.ts: MAIL_PROVIDER=inbox / INBOX_DIR の指定
 *   - .github/workflows/e2e.yml: CI 用セットアップ
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { MailProvider, MailParams, MailResult } from './mail-provider';

export class InboxMailProvider implements MailProvider {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  async send(params: MailParams): Promise<MailResult> {
    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const file = join(this.dir, `${id}.json`);
    const payload = {
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text ?? '',
      receivedAt: new Date().toISOString(),
    };
    writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
    return { success: true, messageId: `inbox-${id}` };
  }
}
