/**
 * Vercel Cron 認証共通ヘルパ (security/auth-secret-hardening, B-6: 2026-05-13)
 *
 * 旧実装は 4 つの cron route で `isCronAuthorized` をそれぞれローカル定義し、
 * `header === \`Bearer ${cronSecret}\`` で文字列比較していた。これは:
 *   1. タイミング攻撃面 (理論上 1 byte ずつ推測可能、実環境では Vercel jitter で困難だが
 *      ベストプラクティス違反)
 *   2. 4 箇所重複で DRY 違反、片方だけ強化されると一貫性が崩れる
 *
 * 本ヘルパで:
 *   - `crypto.timingSafeEqual` による定数時間比較に統一
 *   - CRON_SECRET の最小長 32 文字を起動時検証
 *   - 認可経路を 1 箇所に集約 (将来の認可強化 — IP 制限・JWT 化 — も波及範囲を限定)
 *
 * 呼び出し側 (cron route):
 *   ```ts
 *   if (!isCronAuthorized(req)) {
 *     return NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
 *   }
 *   ```
 */

import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

const MIN_CRON_SECRET_LENGTH = 32;

/**
 * `Authorization: Bearer <CRON_SECRET>` ヘッダを定数時間で検証する。
 *
 * @returns CRON_SECRET 設定済み AND ヘッダ一致なら true、それ以外は false。
 *   `process.env.CRON_SECRET` 未設定または短すぎる (< 32 文字) 場合は常に false
 *   (fail-closed)。
 */
export function isCronAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || cronSecret.length < MIN_CRON_SECRET_LENGTH) {
    // CRON_SECRET 未設定 / 短すぎる場合は cron 自体が無効化される (Vercel Cron も 401)。
    // 起動時に throw する選択肢もあるが、cron 機能のみの劣化で済ませる方が
    // 認証フロー全体への波及を避けられる。
    return false;
  }

  const header = req.headers.get('authorization');
  if (!header) return false;

  const expected = `Bearer ${cronSecret}`;
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const headerBuf = Buffer.from(header, 'utf-8');

  // 長さ不一致時は timingSafeEqual が throw するので先に弾く。
  // 長さ自体で短絡しても情報漏洩はない (Bearer + 32 文字以上の固定長期待値のため)。
  if (expectedBuf.length !== headerBuf.length) return false;

  return timingSafeEqual(expectedBuf, headerBuf);
}
