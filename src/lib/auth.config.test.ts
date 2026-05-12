/**
 * middleware (authorized callback) 単体テスト (2026-05-11)
 *
 * 主な検証観点:
 *   1. Beginner プラン期限切れテナントの write 系 method 弾き (BEGINNER_EXPIRED_READ_ONLY)
 *   2. READ_ONLY_BYPASS_PATHS 経路はテストで明示確認:
 *      - /api/tenants/me (プラン変更 / 予約キャンセル) は read-only 中も通る
 *      - /api/tenants/me/self-delete (セルフ解約) も同じく通る
 *      これにより、ユーザが Day 90 以降でも復帰経路 (アップグレード) と
 *      解約経路 (セルフ削除) を持てる仕様を保証する。
 *   3. GET / HEAD / OPTIONS は read-only 中も無条件で通る
 *
 * 注意:
 *   middleware は Edge runtime で動くため authConfig.callbacks.authorized を
 *   直接関数呼び出ししてテストする (DB / Prisma 依存なし)。
 */

import { describe, it, expect } from 'vitest';
import { authConfig } from './auth.config';

const authorized = authConfig.callbacks!.authorized!;

/**
 * 期限切れ Beginner テナントの auth オブジェクトを作る (createdAt が 90 日以上前)。
 */
function makeExpiredBeginnerAuth() {
  const createdAt = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString();
  return {
    user: {
      tenantPlan: 'beginner',
      tenantCreatedAt: createdAt,
      tenantBeginnerEverUpgraded: false,
      tenantStorageGracePeriodStartedAt: null,
      mfaEnabled: false,
      mfaVerified: false,
    },
  };
}

/**
 * 期限内 Beginner テナント (50 日経過)。
 */
function makeActiveBeginnerAuth() {
  const createdAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString();
  return {
    user: {
      tenantPlan: 'beginner',
      tenantCreatedAt: createdAt,
      tenantBeginnerEverUpgraded: false,
      tenantStorageGracePeriodStartedAt: null,
      mfaEnabled: false,
      mfaVerified: false,
    },
  };
}

/**
 * Expert プランテナント (期限制御対象外)。
 */
function makeExpertAuth() {
  return {
    user: {
      tenantPlan: 'expert',
      tenantCreatedAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      tenantBeginnerEverUpgraded: true,
      tenantStorageGracePeriodStartedAt: null,
      mfaEnabled: false,
      mfaVerified: false,
    },
  };
}

function makeRequest(pathname: string, method: string) {
  // Response.redirect 内部の new URL(path, nextUrl) には絶対 URL が必要なので
  // 本物の URL オブジェクトを使う (path だけのモックだと "Invalid URL" になる)。
  return {
    nextUrl: new URL(`http://localhost:3000${pathname}`),
    method,
    headers: new Headers(),
  } as unknown as Request;
}

describe('authorized callback - Beginner expired read-only ガード', () => {
  it('期限切れ Beginner + POST /api/projects は 403 で弾かれる', async () => {
    const result = await authorized({
      auth: makeExpiredBeginnerAuth(),
      request: makeRequest('/api/projects', 'POST'),
    } as never);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(403);
      const body = await result.json();
      expect(body.error.code).toBe('BEGINNER_EXPIRED_READ_ONLY');
    }
  });

  it('期限切れ Beginner + PATCH /api/memos/[id] は 403', async () => {
    const result = await authorized({
      auth: makeExpiredBeginnerAuth(),
      request: makeRequest('/api/memos/abc-123', 'PATCH'),
    } as never);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) expect(result.status).toBe(403);
  });

  it('期限切れ Beginner + GET /api/projects は通る (read-only でも閲覧可)', async () => {
    const result = await authorized({
      auth: makeExpiredBeginnerAuth(),
      request: makeRequest('/api/projects', 'GET'),
    } as never);

    expect(result).toBe(true);
  });
});

describe('authorized callback - READ_ONLY_BYPASS_PATHS (2026-05-11)', () => {
  it('期限切れ Beginner + PATCH /api/tenants/me は通る (プラン変更経路)', async () => {
    const result = await authorized({
      auth: makeExpiredBeginnerAuth(),
      request: makeRequest('/api/tenants/me', 'PATCH'),
    } as never);

    expect(result).toBe(true);
  });

  it('期限切れ Beginner + DELETE /api/tenants/me は通る (プラン変更予約キャンセル経路)', async () => {
    const result = await authorized({
      auth: makeExpiredBeginnerAuth(),
      request: makeRequest('/api/tenants/me', 'DELETE'),
    } as never);

    expect(result).toBe(true);
  });

  it('期限切れ Beginner + POST /api/tenants/me/self-delete は通る (セルフ解約経路)', async () => {
    const result = await authorized({
      auth: makeExpiredBeginnerAuth(),
      request: makeRequest('/api/tenants/me/self-delete', 'POST'),
    } as never);

    expect(result).toBe(true);
  });

  it('bypass 対象外の /api/tenants/me/foo は通常通り 403 で弾く (path 完全一致のため誤通過しない)', async () => {
    const result = await authorized({
      auth: makeExpiredBeginnerAuth(),
      request: makeRequest('/api/tenants/me/foo', 'POST'),
    } as never);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) expect(result.status).toBe(403);
  });
});

describe('authorized callback - 期限制御対象外', () => {
  it('Expert プランは作成 200 日経過でも POST 通る', async () => {
    const result = await authorized({
      auth: makeExpertAuth(),
      request: makeRequest('/api/projects', 'POST'),
    } as never);

    expect(result).toBe(true);
  });

  it('期限内 Beginner (Day 50) は POST 通る', async () => {
    const result = await authorized({
      auth: makeActiveBeginnerAuth(),
      request: makeRequest('/api/projects', 'POST'),
    } as never);

    expect(result).toBe(true);
  });
});

describe('authorized callback - 未認証', () => {
  it('PUBLIC_PATHS (/login) は未認証でも通る', async () => {
    const result = await authorized({
      auth: null,
      request: makeRequest('/login', 'GET'),
    } as never);

    expect(result).toBe(true);
  });

  it('未認証で保護領域 (/api/projects) は LOGIN_PATH リダイレクト', async () => {
    const result = await authorized({
      auth: null,
      request: makeRequest('/api/projects', 'GET'),
    } as never);

    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      // Response.redirect (status 未指定) は 302 を返す
      expect([302, 307, 308]).toContain(result.status);
      expect(result.headers.get('location')).toContain('/login');
    }
  });
});
