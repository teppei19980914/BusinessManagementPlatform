/**
 * auth-jwt-helper のテスト。
 *
 * 観点 (デグレ防止のため網羅):
 *   - cookie 未存在 → false / Set-Cookie しない
 *   - cookie 不正 (decode 失敗) → false / Set-Cookie しない
 *   - 有効 cookie + mfaVerified=true → 再署名済 JWT が cookie として set される
 *   - 有効 cookie + timezone/locale 更新 → 再署名済 JWT に新値が含まれる
 *   - **既存 claim は保持** (tenantId / id / systemRole 等が消えない) ← 重要
 *   - 許可外 patch (tenantId 等) は無視 ← セキュリティ確認
 *   - cookie 属性 (HttpOnly / SameSite=strict / Path / Secure) が auth.config.ts と一致
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encode, decode } from 'next-auth/jwt';
import { NextRequest, NextResponse } from 'next/server';
import {
  reissueAuthJwtOnResponse,
  AUTH_SESSION_COOKIE_NAME,
} from './auth-jwt-helper';

const TEST_SECRET = 'test-secret-for-jwt-helper-unit-test-only-32bytes';

beforeEach(() => {
  // vitest デフォルトの NODE_ENV='test' のままでテスト可能。
  // 本テストは helper の振る舞いに着目し、cookie 名や Secure フラグの環境差は
  // モジュールエクスポート定数 (AUTH_SESSION_COOKIE_NAME) を経由して透過的に扱う。
  vi.stubEnv('NEXTAUTH_SECRET', TEST_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 既存 JWT を表す claim セット (本番に近い shape) */
const baseToken = {
  id: 'user-1',
  tenantId: 'tenant-1',
  tokenVersion: 0,
  systemRole: 'admin',
  forcePasswordChange: false,
  mfaEnabled: true,
  mfaVerified: false,
  themePreference: 'dark',
  timezone: 'Asia/Tokyo',
  locale: 'ja-JP',
  tenantPlan: 'beginner',
  tenantCreatedAt: '2026-01-01T00:00:00.000Z',
  tenantBeginnerEverUpgraded: false,
  tenantStorageGracePeriodStartedAt: null,
  tenantSuspendedAt: null,
};

async function buildSignedJwt(token = baseToken): Promise<string> {
  return encode({
    token,
    secret: TEST_SECRET,
    salt: AUTH_SESSION_COOKIE_NAME,
    maxAge: 60 * 60,
  });
}

function makeReqWithCookie(cookieValue?: string): NextRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cookieValue) {
    headers.append('cookie', `${AUTH_SESSION_COOKIE_NAME}=${cookieValue}`);
  }
  return new NextRequest('http://test/api/x', { method: 'POST', headers });
}

describe('reissueAuthJwtOnResponse', () => {
  it('cookie 未存在: false を返し Set-Cookie しない', async () => {
    const req = makeReqWithCookie();
    const res = NextResponse.json({ ok: true });
    const ok = await reissueAuthJwtOnResponse(req as never, res, {
      mfaVerified: true,
    });
    expect(ok).toBe(false);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('cookie 不正 (decode 失敗): false を返し Set-Cookie しない', async () => {
    const req = makeReqWithCookie('not-a-valid-jwt');
    const res = NextResponse.json({ ok: true });
    const ok = await reissueAuthJwtOnResponse(req as never, res, {
      mfaVerified: true,
    });
    expect(ok).toBe(false);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('mfaVerified=true で再署名: 新 cookie が set され、claim が更新される', async () => {
    const original = await buildSignedJwt();
    const req = makeReqWithCookie(original);
    const res = NextResponse.json({ ok: true });
    const ok = await reissueAuthJwtOnResponse(req as never, res, {
      mfaVerified: true,
    });
    expect(ok).toBe(true);

    const setCookieHeader = res.headers.get('set-cookie');
    expect(setCookieHeader).not.toBeNull();
    expect(setCookieHeader).toContain(`${AUTH_SESSION_COOKIE_NAME}=`);

    // 新 cookie 値を取り出して decode → mfaVerified が反映されているはず
    const newJwt = setCookieHeader!
      .split(';')[0]
      .replace(`${AUTH_SESSION_COOKIE_NAME}=`, '');
    const decoded = await decode({
      token: newJwt,
      secret: TEST_SECRET,
      salt: AUTH_SESSION_COOKIE_NAME,
    });
    expect(decoded?.mfaVerified).toBe(true);
  });

  it('timezone / locale を再署名: 新 claim が含まれる', async () => {
    const original = await buildSignedJwt();
    const req = makeReqWithCookie(original);
    const res = NextResponse.json({ ok: true });
    const ok = await reissueAuthJwtOnResponse(req as never, res, {
      timezone: 'America/New_York',
      locale: 'en-US',
    });
    expect(ok).toBe(true);

    const newJwt = res.headers
      .get('set-cookie')!
      .split(';')[0]
      .replace(`${AUTH_SESSION_COOKIE_NAME}=`, '');
    const decoded = await decode({
      token: newJwt,
      secret: TEST_SECRET,
      salt: AUTH_SESSION_COOKIE_NAME,
    });
    expect(decoded?.timezone).toBe('America/New_York');
    expect(decoded?.locale).toBe('en-US');
  });

  it('★既存 claim は保持される (id / tenantId / systemRole 等が消えない)', async () => {
    const original = await buildSignedJwt();
    const req = makeReqWithCookie(original);
    const res = NextResponse.json({ ok: true });
    await reissueAuthJwtOnResponse(req as never, res, { mfaVerified: true });

    const newJwt = res.headers
      .get('set-cookie')!
      .split(';')[0]
      .replace(`${AUTH_SESSION_COOKIE_NAME}=`, '');
    const decoded = await decode({
      token: newJwt,
      secret: TEST_SECRET,
      salt: AUTH_SESSION_COOKIE_NAME,
    });

    expect(decoded?.id).toBe(baseToken.id);
    expect(decoded?.tenantId).toBe(baseToken.tenantId);
    expect(decoded?.systemRole).toBe(baseToken.systemRole);
    expect(decoded?.tenantPlan).toBe(baseToken.tenantPlan);
    expect(decoded?.themePreference).toBe(baseToken.themePreference);
    expect(decoded?.tokenVersion).toBe(baseToken.tokenVersion);
  });

  it('★許可外 claim (tenantId 等) は patch しても無視される (セキュリティ)', async () => {
    const original = await buildSignedJwt();
    const req = makeReqWithCookie(original);
    const res = NextResponse.json({ ok: true });
    // 型システムでは弾かれるが、ランタイムでの不正値混入も想定して as never で検査
    await reissueAuthJwtOnResponse(req as never, res, {
      tenantId: 'EVIL-tenant',
      id: 'EVIL-user',
      systemRole: 'super_admin',
    } as never);

    const newJwt = res.headers
      .get('set-cookie')!
      .split(';')[0]
      .replace(`${AUTH_SESSION_COOKIE_NAME}=`, '');
    const decoded = await decode({
      token: newJwt,
      secret: TEST_SECRET,
      salt: AUTH_SESSION_COOKIE_NAME,
    });

    // 元の値が保持されている (改竄されていない) ことを確認
    expect(decoded?.tenantId).toBe(baseToken.tenantId);
    expect(decoded?.id).toBe(baseToken.id);
    expect(decoded?.systemRole).toBe(baseToken.systemRole);
  });

  it('cookie 属性: HttpOnly / SameSite=strict / Path=/ が常に設定される (Secure は production のみ)', async () => {
    const original = await buildSignedJwt();
    const req = makeReqWithCookie(original);
    const res = NextResponse.json({ ok: true });
    await reissueAuthJwtOnResponse(req as never, res, { mfaVerified: true });

    const setCookie = res.headers.get('set-cookie')!;
    // 環境非依存属性
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
    // Secure フラグは NODE_ENV=production 時のみ。本テストは vitest デフォルト ('test') で動作するため、
    // 本番 cookie 設定との一致は production 環境での実機検証 + auth.config.ts レビューで担保する。
  });

  it('空 patch でも既存 claim を破壊しない (no-op として安全)', async () => {
    const original = await buildSignedJwt();
    const req = makeReqWithCookie(original);
    const res = NextResponse.json({ ok: true });
    const ok = await reissueAuthJwtOnResponse(req as never, res, {});
    expect(ok).toBe(true);

    const newJwt = res.headers
      .get('set-cookie')!
      .split(';')[0]
      .replace(`${AUTH_SESSION_COOKIE_NAME}=`, '');
    const decoded = await decode({
      token: newJwt,
      secret: TEST_SECRET,
      salt: AUTH_SESSION_COOKIE_NAME,
    });
    expect(decoded?.mfaVerified).toBe(baseToken.mfaVerified);
    expect(decoded?.timezone).toBe(baseToken.timezone);
    expect(decoded?.locale).toBe(baseToken.locale);
  });
});
