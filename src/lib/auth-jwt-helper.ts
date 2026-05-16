/**
 * NextAuth JWT 再署名ヘルパー (fix/jwt-resign-for-netlify):
 *
 * 役割:
 *   セッション中に JWT claim を更新する必要がある操作 (MFA 検証 / TZ・locale 変更) で、
 *   旧来の `useSession().update()` 経由を避け、API route handler が**直接 JWT を再署名して
 *   Set-Cookie する**ためのユーティリティ。
 *
 * 背景:
 *   - NextAuth v5 0-beta.31 + @netlify/plugin-nextjs では `POST /api/auth/session` の
 *     Set-Cookie レスポンスがブラウザに反映されない事象を確認 (PR #395 で theme は cookie 分離で回避)。
 *   - middleware / SSR / client useSession の各経路で読まれる JWT claim については、cookie 分離
 *     より JWT 自体の更新 (= 全経路で透過的に新値を読める) の方が副作用が少ない。
 *   - 本ヘルパは `auth.config.ts` の cookie 設定 / JWT secret / maxAge と**完全一致**させ、
 *     NextAuth が通常発行する cookie と区別できない形で再署名する。
 *
 * 対応するクレーム:
 *   - mfaVerified  (MFA 検証成功時)
 *   - timezone     (テナント i18n 設定変更時)
 *   - locale       (同上)
 *
 * 関連:
 *   - 旧仕様 (update() 経由): src/app/(auth)/login/mfa/mfa-form.tsx (修正前)
 *                              src/app/(dashboard)/settings/tenant/tenant-settings-client.tsx (修正前)
 *   - KDD: docs/knowledge/KDD_PATTERNS.md "Netlify + NextAuth v5 Set-Cookie 不達" 項
 */

import { decode, encode } from 'next-auth/jwt';
import type { NextRequest, NextResponse } from 'next/server';
import { SESSION_JWT_MAX_AGE_SEC } from '@/config';

/**
 * セッション cookie 名。auth.config.ts と一致させること。
 *
 * NextAuth v5 のデフォルトは production では `__Secure-` プレフィックス付き。
 * salt 引数 (decode/encode に渡す) もこの cookie 名と一致させる必要がある。
 */
export const AUTH_SESSION_COOKIE_NAME =
  process.env.NODE_ENV === 'production'
    ? '__Secure-authjs.session-token'
    : 'authjs.session-token';

/**
 * 再署名後の cookie 設定。auth.config.ts の cookies.sessionToken.options と同一にする。
 * 不一致だとブラウザが「別の cookie」と認識して 2 重発行になり middleware が混乱する。
 *   - httpOnly: true     (JS から触らせない)
 *   - sameSite: 'strict' (PR #198 強化、CWE-1275 対策)
 *   - path: '/'
 *   - secure: production のみ true
 *   - maxAge は指定しない (= セッション cookie、ブラウザを閉じると失効)
 */
function authSessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  };
}

/** 再署名で更新可能な JWT claim の集合。`auth.config.ts` の jwt callback trigger='update' で
 *  許可している項目に合わせる (誤って tenantId など改竄不可な項目を渡さないための型ガード)。 */
export type JwtReissuePatch = {
  mfaVerified?: boolean;
  timezone?: string;
  locale?: string;
};

/** NextAuth secret を取得 (auth.config.ts と同一の優先順位)。 */
function getAuthSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      '[auth-jwt-helper] NEXTAUTH_SECRET / AUTH_SECRET が未設定です。JWT 再署名できません。',
    );
  }
  return secret;
}

/**
 * リクエストから現在の JWT cookie を取り出し、指定の patch を適用して新しい cookie 値で
 * レスポンスに Set-Cookie する。
 *
 * 失敗ケース (cookie 未存在 / decode 失敗) では Set-Cookie を行わず `false` を返す。
 * 呼出側は通常 200 を返しつつ、ログ等で警告できる (UX 影響は次回ログインで自然回復)。
 *
 * @param req   現在のリクエスト (cookies からセッショントークンを読む)
 * @param res   patch 後の Set-Cookie を追加するレスポンス (NextResponse)
 * @param patch 適用する claim
 * @returns 成功時 true / cookie 取得 or decode 失敗時 false
 */
export async function reissueAuthJwtOnResponse(
  req: NextRequest,
  res: NextResponse,
  patch: JwtReissuePatch,
): Promise<boolean> {
  const raw = req.cookies.get(AUTH_SESSION_COOKIE_NAME)?.value;
  if (!raw) return false;

  const secret = getAuthSecret();
  let decoded;
  try {
    decoded = await decode({
      token: raw,
      secret,
      salt: AUTH_SESSION_COOKIE_NAME,
    });
  } catch {
    return false;
  }
  if (!decoded) return false;

  // 許可された claim だけマージ (改竄防止: tenantId / id 等は触らせない)
  const nextToken = { ...decoded };
  if (typeof patch.mfaVerified === 'boolean') {
    nextToken.mfaVerified = patch.mfaVerified;
  }
  if (typeof patch.timezone === 'string' && patch.timezone.length > 0) {
    nextToken.timezone = patch.timezone;
  }
  if (typeof patch.locale === 'string' && patch.locale.length > 0) {
    nextToken.locale = patch.locale;
  }

  const newJwt = await encode({
    token: nextToken,
    secret,
    salt: AUTH_SESSION_COOKIE_NAME,
    maxAge: SESSION_JWT_MAX_AGE_SEC,
  });

  res.cookies.set(AUTH_SESSION_COOKIE_NAME, newJwt, authSessionCookieOptions());
  return true;
}
