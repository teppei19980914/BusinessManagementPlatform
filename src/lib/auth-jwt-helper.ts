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

/** 失敗種別。診断用に呼出側で識別できるようにする。 */
export type ReissueFailureReason =
  | 'cookie_missing'   // リクエストにセッショントークン cookie が無い
  | 'decode_failed'    // cookie の中身を decode できなかった (secret 不一致 / 期限切れ / 改竄等)
  | 'encode_failed';   // 新 JWT の encode に失敗 (NEXTAUTH_SECRET 未設定等の致命的状態)

export type ReissueResult =
  | { ok: true }
  | { ok: false; reason: ReissueFailureReason };

/**
 * リクエストから現在の JWT cookie を取り出し、指定の patch を適用して新しい cookie 値で
 * レスポンスに Set-Cookie する。
 *
 * 失敗時は **theme cookie のように silent fallback はしない**。MFA / TZ / Locale はミドルウェア
 * や SSR が JWT を直接読むため、cookie 更新失敗を黙殺すると「クライアントは成功と思っているが
 * 実態は古い JWT のまま」というユーザ体験上致命的なループに陥る (PR #396 後の本番で実観測)。
 * 呼出側は本関数の戻り値を必ず check し、失敗時は 5xx を返してクライアントに通知すること。
 *
 * @param req   現在のリクエスト (cookies からセッショントークンを読む)
 * @param res   patch 後の Set-Cookie を追加するレスポンス (NextResponse)
 * @param patch 適用する claim
 */
export async function reissueAuthJwtOnResponse(
  req: NextRequest,
  res: NextResponse,
  patch: JwtReissuePatch,
): Promise<ReissueResult> {
  const raw = req.cookies.get(AUTH_SESSION_COOKIE_NAME)?.value;
  if (!raw) {
    logReissueFailure('cookie_missing', {
      availableCookieNames: req.cookies.getAll().map((c) => c.name),
    });
    return { ok: false, reason: 'cookie_missing' };
  }

  const secret = getAuthSecret();
  let decoded;
  try {
    decoded = await decode({
      token: raw,
      secret,
      salt: AUTH_SESSION_COOKIE_NAME,
    });
  } catch (e) {
    logReissueFailure('decode_failed', {
      error: e instanceof Error ? e.message : String(e),
      cookieLength: raw.length,
      cookieNameUsed: AUTH_SESSION_COOKIE_NAME,
    });
    return { ok: false, reason: 'decode_failed' };
  }
  if (!decoded) {
    logReissueFailure('decode_failed', {
      reason: 'decode_returned_null',
      cookieLength: raw.length,
      cookieNameUsed: AUTH_SESSION_COOKIE_NAME,
    });
    return { ok: false, reason: 'decode_failed' };
  }

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

  let newJwt: string;
  try {
    newJwt = await encode({
      token: nextToken,
      secret,
      salt: AUTH_SESSION_COOKIE_NAME,
      maxAge: SESSION_JWT_MAX_AGE_SEC,
    });
  } catch (e) {
    logReissueFailure('encode_failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, reason: 'encode_failed' };
  }

  res.cookies.set(AUTH_SESSION_COOKIE_NAME, newJwt, authSessionCookieOptions());
  return { ok: true };
}

/** Netlify Functions logs に出る形で診断ログを出す。本番でも消さない (頻度は極小)。 */
function logReissueFailure(
  reason: ReissueFailureReason,
  detail: Record<string, unknown>,
): void {
  // eslint-disable-next-line no-console
  console.error('[auth-jwt-helper] reissue_failed', {
    reason,
    nodeEnv: process.env.NODE_ENV,
    ...detail,
  });
}
