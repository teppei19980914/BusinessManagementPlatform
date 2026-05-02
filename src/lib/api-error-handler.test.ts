/**
 * api-error-handler のテスト (PR #2-b で TenantBoundaryError 対応を追加した範囲を中心に検証)。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// 依存モジュールをすべてモック (実行順上、import 解決前に hoist される)
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));
vi.mock('@/services/error-log.service', () => ({
  logUnknownError: vi.fn(),
}));

import { withErrorHandler } from './api-error-handler';
import { TenantBoundaryError } from '@/lib/permissions/tenant';
import { auth } from '@/lib/auth';
import { logUnknownError } from '@/services/error-log.service';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/projects/abc?foo=1&bar=2', {
    method: 'GET',
  });
}

describe('withErrorHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 既定では認証セッションあり
    vi.mocked(auth).mockResolvedValue({
      user: { id: 'user-1', tenantId: TENANT_A },
    } as never);
  });

  describe('TenantBoundaryError ハンドリング (PR #2-b)', () => {
    it('TenantBoundaryError 発生時は 403 + FORBIDDEN コードを返す', async () => {
      const handler = withErrorHandler(async () => {
        throw new TenantBoundaryError(TENANT_A, TENANT_B);
      });
      const res = await handler(makeRequest(), {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toEqual({
        error: {
          code: 'FORBIDDEN',
          message: 'この操作を実行する権限がありません',
        },
      });
    });

    it('レスポンス body に tenantId を含めない (情報漏洩防止)', async () => {
      const handler = withErrorHandler(async () => {
        throw new TenantBoundaryError(TENANT_A, TENANT_B);
      });
      const res = await handler(makeRequest(), {
        params: Promise.resolve({}),
      });
      const bodyText = JSON.stringify(await res.json());
      expect(bodyText).not.toContain(TENANT_A);
      expect(bodyText).not.toContain(TENANT_B);
    });

    it('cross-tenant 試行を warn 重要度で system_error_logs に記録する', async () => {
      const handler = withErrorHandler(async () => {
        throw new TenantBoundaryError(TENANT_A, TENANT_B);
      });
      await handler(makeRequest(), { params: Promise.resolve({}) });

      expect(logUnknownError).toHaveBeenCalledTimes(1);
      const call = vi.mocked(logUnknownError).mock.calls[0]!;
      expect(call[0]).toBe('server'); // source
      expect(call[1]).toBeInstanceOf(TenantBoundaryError);
      const extras = call[2];
      expect(extras?.severity).toBe('warn');
      expect(extras?.userId).toBe('user-1');
      expect(extras?.context).toMatchObject({
        kind: 'tenant_boundary_violation',
        method: 'GET',
        path: '/api/projects/abc',
      });
      // queryKeys は key のみで値は含めない (PII 漏洩防止)
      expect(extras?.context).toMatchObject({
        queryKeys: expect.arrayContaining(['foo', 'bar']),
      });
    });
  });

  describe('一般例外ハンドリング (既存仕様、退行確認)', () => {
    it('一般 Error は 500 + INTERNAL_ERROR を返す', async () => {
      const handler = withErrorHandler(async () => {
        throw new Error('boom');
      });
      const res = await handler(makeRequest(), {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: '内部エラーが発生しました',
        },
      });
    });

    it('一般 Error 時は warn ではなく既定 (error 相当) で記録', async () => {
      const handler = withErrorHandler(async () => {
        throw new Error('boom');
      });
      await handler(makeRequest(), { params: Promise.resolve({}) });
      expect(logUnknownError).toHaveBeenCalledTimes(1);
      const extras = vi.mocked(logUnknownError).mock.calls[0]![2];
      // TenantBoundaryError 経路ではないので severity 上書きなし (undefined → recordError で既定 'error')
      expect(extras?.severity).toBeUndefined();
    });

    it('正常系: handler が NextResponse を return した場合はそのまま返す', async () => {
      const { NextResponse } = await import('next/server');
      const handler = withErrorHandler(async () =>
        NextResponse.json({ ok: true }, { status: 200 }),
      );
      const res = await handler(makeRequest(), {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
      expect(logUnknownError).not.toHaveBeenCalled();
    });
  });

  describe('auth 解決失敗時のフォールバック', () => {
    it('auth() が throw しても TenantBoundaryError 経路は 403 を返せる (silent fail)', async () => {
      vi.mocked(auth).mockRejectedValue(new Error('auth broken'));
      const handler = withErrorHandler(async () => {
        throw new TenantBoundaryError(TENANT_A, TENANT_B);
      });
      const res = await handler(makeRequest(), {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(403);
      // userId は取得できないので undefined
      const extras = vi.mocked(logUnknownError).mock.calls[0]![2];
      expect(extras?.userId).toBeUndefined();
    });
  });
});
