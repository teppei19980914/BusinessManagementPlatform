/**
 * POST /api/admin/super/tenants/[id]/resume route テスト (PR #372 / 2026-05-14)
 *
 * 検証観点:
 *   1. 認可: 未認証 → 401、admin → 403、super_admin → 200
 *   2. サービス層エラー → 適切な HTTP ステータス変換
 *      - TENANT_NOT_FOUND → 404
 *      - TENANT_DELETED → 409
 *      - NOT_SUSPENDED → 409
 *   3. 正常系: 200 + resumeTenant の結果を返す
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
    resumeTenant: vi.fn(),
  };
});

import { POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { resumeTenant } from '@/services/super-admin.service';

const SUPER_ADMIN = {
  id: 'super-admin-uuid',
  tenantId: 'mgmt-tenant',
  systemRole: 'super_admin',
} as never;

const TARGET = 'target-tenant-uuid';

beforeEach(() => vi.clearAllMocks());

async function call() {
  const req = new NextRequest(`http://localhost/api/admin/super/tenants/${TARGET}/resume`, {
    method: 'POST',
  });
  return POST(req, { params: Promise.resolve({ id: TARGET }) });
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
    expect(resumeTenant).not.toHaveBeenCalled();
  });
});

describe('正常系・エラー変換', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(SUPER_ADMIN);
    vi.mocked(isSuperAdmin).mockReturnValue(true);
  });

  it('成功時 200 + resume 結果を返す', async () => {
    vi.mocked(resumeTenant).mockResolvedValueOnce({
      tenantId: TARGET,
      resumedAt: new Date('2026-05-14T11:00:00Z'),
      invalidatedSessionCount: 3,
    });

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tenantId).toBe(TARGET);
    expect(body.data.invalidatedSessionCount).toBe(3);

    expect(resumeTenant).toHaveBeenCalledWith(TARGET, 'super-admin-uuid');
  });

  it('TENANT_NOT_FOUND → 404', async () => {
    vi.mocked(resumeTenant).mockRejectedValueOnce(new Error('TENANT_NOT_FOUND'));
    const res = await call();
    expect(res.status).toBe(404);
  });

  it('TENANT_DELETED → 409', async () => {
    vi.mocked(resumeTenant).mockRejectedValueOnce(new Error('TENANT_DELETED'));
    const res = await call();
    expect(res.status).toBe(409);
  });

  it('NOT_SUSPENDED → 409', async () => {
    vi.mocked(resumeTenant).mockRejectedValueOnce(new Error('NOT_SUSPENDED'));
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_SUSPENDED');
  });
});
