/**
 * Inbox プロバイダ reader (PR #92)
 *
 * 役割:
 *   InboxMailProvider が書き出した JSON ファイル群を走査し、宛先や件名で
 *   マッチするメールを取得する。招待メールからトークン URL を抽出するために使用。
 *
 *   Playwright のテスト側プロセスと Next.js サーバ側プロセスが別々なため、
 *   共有は INBOX_DIR を介したファイルシステム経由となる。
 *
 * 関連:
 *   - src/lib/mail/inbox-provider.ts: 書き込み側
 *   - playwright.config.ts: INBOX_DIR の指定
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export type InboxMail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  receivedAt: string;
  file: string;
};

function inboxDir(): string {
  const dir = process.env.INBOX_DIR;
  if (!dir) {
    throw new Error(
      'INBOX_DIR が未設定です。playwright.config.ts で MAIL_PROVIDER=inbox + INBOX_DIR を設定してください。',
    );
  }
  return dir;
}

function listMails(): InboxMail[] {
  const dir = inboxDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const payload = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      return { ...payload, file: join(dir, f) } as InboxMail;
    })
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
}

/**
 * 指定メールアドレス宛の最新メールが届くまで待つ。
 * デフォルト 10 秒 / 250ms 間隔で polling。
 */
export async function waitForMail(
  to: string,
  options: { timeoutMs?: number; intervalMs?: number; after?: string } = {},
): Promise<InboxMail> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 250;
  const after = options.after;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const mails = listMails().filter((m) => m.to === to);
    const matched = after ? mails.filter((m) => m.receivedAt > after) : mails;
    if (matched.length > 0) {
      return matched[matched.length - 1];
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${to} 宛てのメールが ${timeoutMs}ms 以内に届きませんでした`);
}

/**
 * 招待メール HTML から setup-password トークン URL を抽出する。
 */
export function extractSetupPasswordUrl(mail: InboxMail): string {
  const match = mail.html.match(/href="([^"]*\/setup-password\?token=[^"]+)"/);
  if (!match) {
    throw new Error(`招待メール本文から setup-password URL を抽出できません: ${mail.html.slice(0, 200)}`);
  }
  return match[1];
}

/**
 * token= クエリ文字列を取り出す (Next.js サーバは絶対 URL を出力するため、相対に正規化する場合に使用)。
 */
export function extractToken(url: string): string {
  const m = url.match(/[?&]token=([^&#]+)/);
  if (!m) throw new Error(`URL からトークンを抽出できません: ${url}`);
  return m[1];
}
