/**
 * HTTP Basic 認証ヘルパ (PR-V7 / 2026-05-19)
 *
 * 役割:
 *   `/admin/super/*` および `/api/admin/super/*` 配下のアクセス制御に使用される
 *   Basic 認証の検証ロジック。**Edge runtime (middleware) で動作する** ため、
 *   Node.js 専用 API (Buffer 等) は使えず、Web 標準の btoa / charCodeAt のみで実装。
 *
 * 設計判断 (= クレジット取引セキュリティ対策協議会 1.1 対応):
 *   割賦販売法に基づくクレ協チェックリストで「管理者画面のアクセス制限」(IP 制限 or
 *   ベーシック認証等) が必須要件。super_admin が参照する画面群 (BillingHistory /
 *   利用量集計 / DLQ 等) はカード取引関連データを扱うため適用対象。
 *
 *   Basic Auth を採用した理由:
 *     - 個人事業主・単一開発者の運用前提では、IP 制限よりロケーションフリーで実用的
 *     - パスワード 32 文字以上 + constant-time 比較で実質ブルートフォース不可能
 *     - middleware で NextAuth より先に検証 → ログイン画面到達前に弾ける多層防御
 *
 * セキュリティ要件:
 *   - **constant-time 比較**: タイミング攻撃で文字を 1 文字ずつ推測されないよう、
 *     文字列長一致時は必ず全文字を比較する
 *   - **base64 デコード**: 不正なヘッダ形式で例外を投げず false を返す
 *
 * 関連:
 *   - 呼出側: src/middleware.ts (/admin/super/* + /api/admin/super/* 配下)
 *   - 環境変数: ADMIN_SUPER_BASIC_AUTH_USER / ADMIN_SUPER_BASIC_AUTH_PASS
 *   - 規格: RFC 7617 (Basic Authentication Scheme)
 */

/**
 * Authorization ヘッダ値 (= "Basic xxxxxx") が期待するユーザ/パスワードと一致するか検証。
 *
 * Edge runtime 制約:
 *   - Node.js Buffer 使用不可 → Web 標準の btoa を使用
 *   - constant-time 比較: charCodeAt の XOR を全文字累積し、最終結果のみ確認
 *
 * @param authHeader Authorization リクエストヘッダの値 (null / undefined OK)
 * @param expectedUser 期待するユーザ名
 * @param expectedPass 期待するパスワード
 * @returns 一致時 true、それ以外 false
 */
export function verifyBasicAuth(
  authHeader: string | null | undefined,
  expectedUser: string,
  expectedPass: string,
): boolean {
  if (!authHeader || typeof authHeader !== 'string') return false;
  if (!authHeader.startsWith('Basic ')) return false;

  // 期待値を encode (= 攻撃者に既知の expected を生成、constant-time 比較する)
  let expected: string;
  try {
    expected = `Basic ${btoa(`${expectedUser}:${expectedPass}`)}`;
  } catch {
    // btoa は ASCII 範囲外文字でエラー。env 設定不備として false。
    return false;
  }

  // constant-time 文字列比較 (= timing attack 対策)
  if (authHeader.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < authHeader.length; i++) {
    mismatch |= authHeader.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * 環境変数から Basic Auth 設定を取得し、その有効/無効を判定する。
 *
 * 動作:
 *   - 両方 set (= USER と PASS の両方) → `enabled: true`
 *   - 両方 unset → `enabled: false` (= 開発/E2E 環境)
 *   - 片方のみ set → fail-closed として `enabled: true` + 検証時に絶対通らない値で扱う
 *     (= 設定ミスを sairan で吸収せず、認証失敗で気付かせる)
 *
 * 環境変数:
 *   - `ADMIN_SUPER_BASIC_AUTH_USER`: ユーザ名
 *   - `ADMIN_SUPER_BASIC_AUTH_PASS`: パスワード (32 文字以上推奨)
 */
export type BasicAuthConfig =
  | { enabled: false }
  | { enabled: true; user: string; pass: string };

export function getAdminSuperBasicAuthConfig(env: NodeJS.ProcessEnv = process.env): BasicAuthConfig {
  const user = env.ADMIN_SUPER_BASIC_AUTH_USER;
  const pass = env.ADMIN_SUPER_BASIC_AUTH_PASS;

  // 両方 unset = 開発/E2E モード (= Basic Auth 無効)
  if (!user && !pass) return { enabled: false };

  // 片方のみ set = fail-closed (= 設定ミス検知)。誰も通れない値を返す。
  if (!user || !pass) {
    return {
      enabled: true,
      user: '__ADMIN_SUPER_BASIC_AUTH_MISCONFIGURED__',
      pass: '__ADMIN_SUPER_BASIC_AUTH_MISCONFIGURED__',
    };
  }

  return { enabled: true, user, pass };
}

/**
 * 401 Unauthorized + WWW-Authenticate ヘッダの Response を生成。
 * ブラウザは WWW-Authenticate を見て Basic Auth プロンプトを表示する。
 */
export function buildBasicAuthChallenge(realm = 'Super Admin Area'): Response {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}
