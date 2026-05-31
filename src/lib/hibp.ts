/**
 * HIBP (Have I Been Pwned) k-anonymity API クライアント
 *   security/phase-3 (2026-05-31)
 *
 * 役割:
 *   ユーザが新規に設定しようとしているパスワードが、過去のデータ漏洩で
 *   公開済 (= 流出済) かどうかを HIBP の pwned passwords API で照合する。
 *
 * k-anonymity 仕様:
 *   - パスワード平文を送らず、SHA-1(password) の **先頭 5 文字 (prefix)** だけを送る。
 *   - HIBP は同 prefix の hash サフィックス一覧 (= 全世界の流出 hash) を返す。
 *   - クライアント側で自分の SHA-1 の **残り 35 文字 (suffix)** がリストにあるか照合。
 *   - 結果として、HIBP 運営者にも生パスワードや完全 hash は伝わらない。
 *
 * fail-open 設計:
 *   - HIBP API は外部依存。タイムアウト / 5xx / ネットワーク障害時に **signup を止めない** よう
 *     fail-open (= pwned 判定なし) で返却する。
 *   - 本来は fail-closed が望ましいが、HIBP 依存で本サービスのオンボーディングが止まる UX を
 *     避ける。攻撃面の主要回避策は **既存 user の password policy + bcrypt + MFA** で確保。
 *
 * テスト / オフライン環境:
 *   - `NODE_ENV='test'` または `process.env.SKIP_HIBP === 'true'` で HIBP 呼出を skip。
 *   - これにより既存単体テスト・E2E テスト・オフライン開発で外部 fetch を発生させない。
 *
 * 仕様参照:
 *   - https://haveibeenpwned.com/API/v3#PwnedPasswords (公式 v3 仕様)
 *   - https://api.pwnedpasswords.com/range/{first5}  (k-anonymity endpoint)
 */

import { createHash } from 'crypto';

const HIBP_RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range/';
const HIBP_TIMEOUT_MS = 3000;

export interface PwnedCheckResult {
  /** 流出済と判定されたか */
  pwned: boolean;
  /** HIBP データセット内での出現回数 (pwned=false 時は 0) */
  count: number;
}

/**
 * HIBP データセットに該当パスワードが含まれているか確認する (k-anonymity)。
 *
 * - テスト環境 / SKIP_HIBP 環境では常に `{ pwned: false, count: 0 }`
 * - HIBP 障害時も `{ pwned: false, count: 0 }` (fail-open)
 */
export async function isPasswordPwned(password: string): Promise<PwnedCheckResult> {
  // テスト・オフライン環境では外部呼出を skip
  if (process.env.NODE_ENV === 'test' || process.env.SKIP_HIBP === 'true') {
    return { pwned: false, count: 0 };
  }

  try {
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const res = await fetch(`${HIBP_RANGE_ENDPOINT}${prefix}`, {
      headers: {
        // Add-Padding: HIBP がレスポンスにダミー行を混ぜることでネットワーク監視からの
        //   prefix/suffix サイズ推定を防ぐ仕様。常に true でリクエストする。
        'Add-Padding': 'true',
        'User-Agent': 'tasukiba-security-check/1.0',
      },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
    });

    if (!res.ok) {
      // fail-open: HIBP 障害時は signup / 変更を止めない (UX 優先)
      return { pwned: false, count: 0 };
    }

    const text = await res.text();
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx <= 0) continue;
      const hashSuffix = line.slice(0, colonIdx);
      const countStr = line.slice(colonIdx + 1);
      if (hashSuffix === suffix) {
        const parsed = parseInt(countStr, 10);
        // Add-Padding 用のダミー行は count=0、これは pwned 扱いしない
        if (!Number.isFinite(parsed) || parsed <= 0) return { pwned: false, count: 0 };
        return { pwned: true, count: parsed };
      }
    }
    return { pwned: false, count: 0 };
  } catch {
    // ネットワーク例外 / timeout はすべて fail-open
    return { pwned: false, count: 0 };
  }
}

/**
 * パスワードが流出済の場合に `PwnedPasswordError` を throw する helper。
 * 各 password 設定経路 (signup / resetPassword / changePassword) で呼ぶ。
 */
export async function assertPasswordNotPwned(password: string): Promise<void> {
  const result = await isPasswordPwned(password);
  if (result.pwned) {
    throw new PwnedPasswordError(result.count);
  }
}

export class PwnedPasswordError extends Error {
  constructor(public readonly pwnedCount: number) {
    super(
      `PWNED_PASSWORD: this password has been seen ${pwnedCount} times in known data breaches`,
    );
    this.name = 'PwnedPasswordError';
  }
}
