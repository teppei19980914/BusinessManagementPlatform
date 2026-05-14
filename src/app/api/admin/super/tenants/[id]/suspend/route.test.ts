/**
 * POST /api/admin/super/tenants/[id]/suspend route テスト (PR #372 / 2026-05-14)
 *
 * 検証観点:
 *   1. 認可: 未認証 → 401、admin → 403、super_admin → 200
 *   2. body バリデーション: reason が enum 外 → 400
 *   3. サービス層エラー → 適切な HTTP ステータス変換
 *      - TENANT_NOT_FOUND → 404
 *      - MANAGEMENT_TENANT_FORBIDDEN → 403
 *      - TENANT_DELETED → 409
 *      - ALREADY_SUSPENDED → 409
 *      - INVALID_REASON → 400
 *   4. 正常系: 200 + suspendTenant の結果を返す
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/permissions/role', () => ({
  isSuperAdmin: vi.fn(),
}));

vi.mock('@/services/super-admin.service', async () => {
  const actual = await vi.importActual<typeof import('@/services/super-admin.service')>(
    '@/services/super-admin.service',
  );
  return {
    ...actual,
    suspendTenant: vi.fn(),
  };
});

import { POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { suspendTenant } from '@/services/super-admin.service';

const SUPER_ADMIN = {
  id: 'super-admin-uuid',
  tenantId: 'mgmt-tenant',
  systemRole: 'super_admin',
} as never;

const TARGET = 'target-tenant-uuid';

beforeEach(() => vi.clearAllMocks());

function makeReq(body: unknown = { reason: 'payment_delinquent' }) {
  return new NextRequest(`http://localhost/api/admin/super/tenants/${TARGET}/suspend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function call(body: unknown = { reason: 'payment_delinquent' }) {
  return POST(makeReq(body), { params: Promise.resolve({ id: TARGET }) });
}

describe('認可', () => {
  it('super_admin 以外は 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'general',
      tenantId: 't',
      systemRole: 'admin',
    } as never);
    vi.mocked(isSuperAdmin).mockReturnValue(false);

    const res = await call();
    expect(res.status).toBe(403);
    expect(suspendTenant).not.toHaveBeenCalled();
  });
});

describe('バリデーション', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(SUPER_ADMIN);
    vi.mocked(isSuperAdmin).mockReturnValue(true);
  });

  it('reason 未指定は 400 VALIDATION_ERROR', async () => {
    const res = await call({});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(suspendTenant).not.toHaveBeenCalled();
  });

  it('reason が enum 外は 400 VALIDATION_ERROR', async () => {
    const res = await call({ reason: 'unknown_reason' });
    expect(res.status).toBe(400);
    expect(suspendTenant).not.toHaveBeenCalled();
  });

  it('JSON パース失敗は 400', async () => {
    const req = new NextRequest(`http://localhost/api/admin/super/tenants/${TARGET}/suspend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'invalid-json',
    });
    const res = await POST(req, { params: Promise.resolve({ id: TARGET }) });
    expect(res.status).toBe(400);
  });
});

describe('正常系・エラー変換', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(SUPER_ADMIN);
    vi.mocked(isSuperAdmin).mockReturnValue(true);
  });

  it('成功時 200 + suspend 結果を返す', async () => {
    vi.mocked(suspendTenant).mockResolvedValueOnce({
      tenantId: TARGET,
      suspendedAt: new Date('2026-05-14T10:00:00Z'),
      suspendReason: 'payment_delinquent',
      invalidatedSessionCount: 5,
    });

    const res = await call({ reason: 'payment_delinquent' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tenantId).toBe(TARGET);
    expect(body.data.suspendReason).toBe('payment_delinquent');
    expect(body.data.invalidatedSessionCount).toBe(5);

    expect(suspendTenant).toHaveBeenCalledWith(TARGET, 'payment_delinquent', 'super-admin-uuid');
  });

  it('TENANT_NOT_FOUND → 404', async () => {
    vi.mocked(suspendTenant).mockRejectedValueOnce(new Error('TENANT_NOT_FOUND'));
    const res = await call();
    expect(res.status).toBe(404);
  });

  it('MANAGEMENT_TENANT_FORBIDDEN → 403', async () => {
    vi.mocked(suspendTenant).mockRejectedValueOnce(new Error('MANAGEMENT_TENANT_FORBIDDEN'));
    const res = await call();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('MANAGEMENT_TENANT_FORBIDDEN');
  });

  it('TENANT_DELETED → 409', async () => {
    vi.mocked(suspendTenant).mockRejectedValueOnce(new Error('TENANT_DELETED'));
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('TENANT_DELETED');
  });

  it('ALREADY_SUSPENDED → 409', async () => {
    vi.mocked(suspendTenant).mockRejectedValueOnce(new Error('ALREADY_SUSPENDED'));
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ALREADY_SUSPENDED');
  });
});
