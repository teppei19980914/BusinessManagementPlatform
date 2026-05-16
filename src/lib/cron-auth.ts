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
 * cron auth 判定結果。
 *
 * 2026-05-18 (PR feat/cron-execution-log):
 *   旧 API (boolean を返す `isCronAuthorized`) は失敗時に「なぜ」が分からず、
 *   cron-job.org 側の設定誤り (= Bearer prefix 漏れ、CRON_SECRET 不一致) を
 *   診断するのに Function logs を直接見るしかなかった。
 *   本 result type で「Bearer 付与あるが secret 不一致」と「そもそも Bearer なし」を
 *   区別し、route 側で適切な error code を返せるようにする。
 */
export type CronAuthResult =
  | { ok: true }
  | { ok: false; reason: 'server_secret_missing' } // サーバ側 env が未設定/短すぎる (= fail-closed)
  | { ok: false; reason: 'no_bearer_header' }      // Authorization header 自体がない
  | { ok: false; reason: 'invalid_bearer_format' } // header はあるが `Bearer ...` 形式でない
  | { ok: false; reason: 'secret_mismatch' };      // Bearer 形式 OK だが secret が一致しない

/**
 * `Authorization: Bearer <CRON_SECRET>` ヘッダを定数時間で検証する。
 *
 * @returns 詳細な失敗理由付き判定結果。本体ルートは `ok=false` のとき reason に応じて
 *   error code (CRON_NO_BEARER / CRON_BEARER_MALFORMED / CRON_SECRET_MISMATCH /
 *   CRON_SECRET_MISCONFIGURED) を返すと診断しやすい。
 */
export function checkCronAuthorization(req: NextRequest): CronAuthResult {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || cronSecret.length < MIN_CRON_SECRET_LENGTH) {
    // CRON_SECRET 未設定 / 短すぎる場合は cron 自体が無効化される。
    // 起動時に throw する選択肢もあるが、cron 機能のみの劣化で済ませる方が
    // 認証フロー全体への波及を避けられる。
    return { ok: false, reason: 'server_secret_missing' };
  }

  const header = req.headers.get('authorization');
  if (!header) return { ok: false, reason: 'no_bearer_header' };

  if (!header.startsWith('Bearer ')) {
    // 'Bearer ' (大文字 B、半角スペース) で始まらない → format 不正。
    // cron-job.org 設定で `Bearer ` prefix 漏れの誤設定を診断できるようにするため、
    // secret_mismatch ではなく専用の reason を返す。
    return { ok: false, reason: 'invalid_bearer_format' };
  }

  const expected = `Bearer ${cronSecret}`;
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const headerBuf = Buffer.from(header, 'utf-8');

  // 長さ不一致時は timingSafeEqual が throw するので先に弾く。
  // 長さ自体で短絡しても情報漏洩はない (Bearer + 32 文字以上の固定長期待値のため)。
  if (expectedBuf.length !== headerBuf.length) {
    return { ok: false, reason: 'secret_mismatch' };
  }

  const matched = timingSafeEqual(expectedBuf, headerBuf);
  return matched ? { ok: true } : { ok: false, reason: 'secret_mismatch' };
}

/**
 * @deprecated 新規コードは `checkCronAuthorization(req)` を使うこと (失敗理由が取れる)。
 *   既存呼出側との後方互換のため boolean ラッパを残す。
 */
export function isCronAuthorized(req: NextRequest): boolean {
  return checkCronAuthorization(req).ok;
}
