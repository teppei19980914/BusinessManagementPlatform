/**
 * POST /api/admin/super/recalculate-all (2026-05-14)
 *
 * 検証観点:
 *   1. 認可: 未認証 → 401、admin / general → 403、super_admin → 200
 *   2. 動作: updateAllStorageBytesUsed と reconcileAllTenantsApiUsage が並列実行される
 *   3. 監査ログ: super_admin が呼んだら recordAuditLog が actor の management tenantId で記録される
 *   4. drift カウント: hasDrift=true のテナント数が response に含まれる
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/permissions/role', () => ({
  isSuperAdmin: vi.fn(),
}));

vi.mock('@/services/tenant-storage.service', () => ({
  updateAllStorageBytesUsed: vi.fn(),
}));

vi.mock('@/services/api-usage-recalc.service', () => ({
  reconcileAllTenantsApiUsage: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));

import { POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { updateAllStorageBytesUsed } from '@/services/tenant-storage.service';
import { reconcileAllTenantsApiUsage } from '@/services/api-usage-recalc.service';
import { recordAuditLog } from '@/services/audit.service';

const SUPER_ADMIN = {
  id: 'super-admin-uuid',
  tenantId: 'mgmt-tenant',
  systemRole: 'super_admin',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('認可', () => {
  it('未認証 → getAuthenticatedUser が NextResponse を返す → そのまま透過', async () => {
    const unauthRes = NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    vi.mocked(getAuthenticatedUser).mockResolvedValue(unauthRes);
    const req = new NextRequest('http://localhost/api/admin/super/recalculate-all', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(updateAllStorageBytesUsed).not.toHaveBeenCalled();
    expect(reconcileAllTenantsApiUsage).not.toHaveBeenCalled();
  });

  it('admin (tenant admin) → 403 (super_admin ロール限定)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u1', tenantId: 't1', systemRole: 'admin',
    } as never);
    vi.mocked(isSuperAdmin).mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/admin/super/recalculate-all', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(updateAllStorageBytesUsed).not.toHaveBeenCalled();
    expect(reconcileAllTenantsApiUsage).not.toHaveBeenCalled();
  });

  it('general → 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u1', tenantId: 't1', systemRole: 'general',
    } as never);
    vi.mocked(isSuperAdmin).mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/admin/super/recalculate-all', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(403);
  });
});

describe('正常系 (super_admin)', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(SUPER_ADMIN);
    vi.mocked(isSuperAdmin).mockReturnValue(true);
  });

  it('updateAllStorageBytesUsed + reconcileAllTenantsApiUsage を呼び、結果を返す', async () => {
    vi.mocked(updateAllStorageBytesUsed).mockResolvedValue(5);
    vi.mocked(reconcileAllTenantsApiUsage).mockResolvedValue([
      // PR-V8 (2026-05-19): driftCallRatio / driftCostRatio / monthStart フィールド追加
      { tenantId: 't1', cachedCallCount: 0, cachedCostJpy: 0, reconciledCallCount: 0, reconciledCostJpy: 0, driftCallCount: 0, driftCostJpy: 0, driftCallRatio: 0, driftCostRatio: 0, driftRatio: 0, monthStart: new Date(), monthStartUtc: new Date(), hasDrift: false },
      { tenantId: 't2', cachedCallCount: 100, cachedCostJpy: 1000, reconciledCallCount: 90, reconciledCostJpy: 900, driftCallCount: 10, driftCostJpy: 100, driftCallRatio: 0.11, driftCostRatio: 0.11, driftRatio: 0.11, monthStart: new Date(), monthStartUtc: new Date(), hasDrift: true },
    ]);

    const req = new NextRequest('http://localhost/api/admin/super/recalculate-all', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.storage.tenantsUpdated).toBe(5);
    expect(body.data.apiUsage.tenantsChecked).toBe(2);
    expect(body.data.apiUsage.tenantsWithDrift).toBe(1);
    expect(updateAllStorageBytesUsed).toHaveBeenCalled();
    expect(reconcileAllTenantsApiUsage).toHaveBeenCalled();
  });

  it('監査ログを actor の management tenantId で記録 (entityType=system)', async () => {
    vi.mocked(updateAllStorageBytesUsed).mockResolvedValue(2);
    vi.mocked(reconcileAllTenantsApiUsage).mockResolvedValue([]);

    const req = new NextRequest('http://localhost/api/admin/super/recalculate-all', { method: 'POST' });
    await POST(req);

    // PR-V8 (2026-05-19): entityId は uuid 制約のため MANAGEMENT_TENANT_ID に変更
    //   (旧 'all-tenants' は uuid 違反で silent fail していた)
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'mgmt-tenant',
        userId: 'super-admin-uuid',
        action: 'UPDATE',
        entityType: 'system',
        entityId: '00000000-0000-0000-0000-ffffffffffff', // = MANAGEMENT_TENANT_ID
      }),
    );
  });
});
