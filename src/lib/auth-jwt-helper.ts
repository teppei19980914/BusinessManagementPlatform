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
 *
 * 対応するクレーム:
 *   - mfaVerified  (MFA 検証成功時)
 *   - timezone     (テナント i18n 設定変更時)
 *   - locale       (同上)
 *
 * ★ Cookie 名の auto-detect (2026-05-18 PR #398):
 *   旧実装は `process.env.NODE_ENV === 'production'` で cookie 名 (__Secure- prefix の有無) を
 *   決めていたが、これは NextAuth 内部の判定 (`url.protocol === "https:"`) と食い違うことが判明。
 *   Netlify Functions runtime で NODE_ENV が 'production' でない場合に salt mismatch で
 *   decode が失敗し、MFA 検証ループに陥った (実観測)。
 *
 *   現実装は **request の cookies から実在する名前を auto-detect** し、その名前を
 *   cookie 名 AND salt として一貫して使う。これにより NextAuth がどちらの prefix で署名していても
 *   正しく decode できる。
 *
 * 関連:
 *   - KDD: docs/knowledge/KDD_PATTERNS.md §5.X+66 / §5.X+68
 *   - @auth/core encode/decode: salt は `options.cookies.sessionToken.name` (NextAuth 内部)
 */

import { decode, encode } from 'next-auth/jwt';
import type { NextRequest, NextResponse } from 'next/server';
import { SESSION_JWT_MAX_AGE_SEC } from '@/config';

/**
 * NextAuth が使う可能性のあるセッション cookie 名の候補。
 * Production (HTTPS) では `__Secure-` prefix 付き、dev (HTTP) では prefix 無し。
 * NextAuth 内部の `defaultCookies(url.protocol === "https:")` と一致する。
 */
const SECURE_COOKIE_NAME = '__Secure-authjs.session-token';
const INSECURE_COOKIE_NAME = 'authjs.session-token';

/**
 * @deprecated 新規コードは `detectAuthCookieName(req)` を使うこと。
 * 後方互換のため export を残す (テストから参照されているため)。production の cookie 名を返す。
 */
export const AUTH_SESSION_COOKIE_NAME = SECURE_COOKIE_NAME;

/** 失敗種別。診断用に呼出側で識別できるようにする。 */
export type ReissueFailureReason =
  | 'cookie_missing'   // リクエストにセッショントークン cookie が無い
  | 'decode_failed'    // cookie の中身を decode できなかった (secret 不一致 / 期限切れ / 改竄等)
  | 'encode_failed';   // 新 JWT の encode に失敗 (NEXTAUTH_SECRET 未設定等の致命的状態)

export type ReissueResult =
  | { ok: true }
  | { ok: false; reason: ReissueFailureReason };

/** 再署名で更新可能な JWT claim の集合。`auth.config.ts` の jwt callback trigger='update' で
 *  許可している項目に合わせる (誤って tenantId など改竄不可な項目を渡さないための型ガード)。 */
export type JwtReissuePatch = {
  mfaVerified?: boolean;
  timezone?: string;
  locale?: string;
  /**
   * 2026-06-03 (feat/logout-other-devices): tokenVersion を新値で再署名する。
   * 「他の端末からログアウト」操作で DB.tokenVersion を increment した後、**呼出端末のみ**
   * 新 tokenVersion で JWT を再署名し、現在の端末はログインを維持する用途。
   * (他端末は旧 tokenVersion のまま → 次回リクエストで getAuthenticatedUser が 401)。
   */
  tokenVersion?: number;
};

/**
 * リクエストの cookies から実在するセッショントークン cookie 名を検出する。
 *
 * NextAuth は signing 時に config の `cookies.sessionToken.name` を salt として使う (確認済)。
 * その config 値は NextAuth 内部で `url.protocol === "https:"` 判定により `__Secure-` prefix が付く。
 * 一方、本ヘルパが `NODE_ENV` で判定すると runtime 差で食い違う恐れがあるため、**実在 cookie 名から
 * 逆引きする**設計に変更した。検出した名前は decode/encode の salt と Set-Cookie の name の双方に
 * 使う (= NextAuth の署名と完全に整合)。
 */
function detectAuthCookieName(req: NextRequest): string | null {
  if (req.cookies.get(SECURE_COOKIE_NAME)) return SECURE_COOKIE_NAME;
  if (req.cookies.get(INSECURE_COOKIE_NAME)) return INSECURE_COOKIE_NAME;
  return null;
}

/**
 * 再署名後の cookie 設定を生成する。auth.config.ts の cookies.sessionToken.options と整合させる。
 *   - httpOnly: true     (JS から触らせない)
 *   - sameSite: 'strict' (PR #198 強化、CWE-1275 対策)
 *   - path: '/'
 *   - secure: cookie 名が `__Secure-` prefix を含む場合のみ true (browser が prefix を強制)
 *   - maxAge は指定しない (= セッション cookie、ブラウザを閉じると失効)
 */
function authSessionCookieOptions(cookieName: string) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: '/',
    secure: cookieName.startsWith('__Secure-'),
  };
}

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
 * 失敗時は theme cookie のような silent fallback はしない。MFA / TZ / Locale はミドルウェアや
 * SSR が JWT を直接読むため、cookie 更新失敗を黙殺すると「クライアントは成功と思っているが
 * 実態は古い JWT のまま」という致命的なループに陥る (PR #396 後の本番で実観測)。
 * 呼出側は本関数の戻り値を必ず check し、失敗時は 5xx を返してクライアントに通知すること。
 */
export async function reissueAuthJwtOnResponse(
  req: NextRequest,
  res: NextResponse,
  patch: JwtReissuePatch,
): Promise<ReissueResult> {
  const cookieName = detectAuthCookieName(req);
  if (!cookieName) {
    logReissueFailure('cookie_missing', {
      availableCookieNames: req.cookies.getAll().map((c) => c.name),
      triedNames: [SECURE_COOKIE_NAME, INSECURE_COOKIE_NAME],
    });
    return { ok: false, reason: 'cookie_missing' };
  }

  const raw = req.cookies.get(cookieName)!.value;
  const secret = getAuthSecret();
  let decoded;
  try {
    decoded = await decode({
      token: raw,
      secret,
      salt: cookieName,
    });
  } catch (e) {
    logReissueFailure('decode_failed', {
      error: e instanceof Error ? e.message : String(e),
      cookieLength: raw.length,
      cookieNameUsed: cookieName,
    });
    return { ok: false, reason: 'decode_failed' };
  }
  if (!decoded) {
    logReissueFailure('decode_failed', {
      reason: 'decode_returned_null',
      cookieLength: raw.length,
      cookieNameUsed: cookieName,
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
  if (typeof patch.tokenVersion === 'number' && Number.isInteger(patch.tokenVersion)) {
    nextToken.tokenVersion = patch.tokenVersion;
  }

  let newJwt: string;
  try {
    newJwt = await encode({
      token: nextToken,
      secret,
      salt: cookieName,
      maxAge: SESSION_JWT_MAX_AGE_SEC,
    });
  } catch (e) {
    logReissueFailure('encode_failed', {
      error: e instanceof Error ? e.message : String(e),
      cookieNameUsed: cookieName,
    });
    return { ok: false, reason: 'encode_failed' };
  }

  res.cookies.set(cookieName, newJwt, authSessionCookieOptions(cookieName));
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
