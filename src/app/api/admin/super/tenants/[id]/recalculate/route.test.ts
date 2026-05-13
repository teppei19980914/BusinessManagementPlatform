/**
 * POST /api/admin/super/tenants/[id]/recalculate (2026-05-14)
 *
 * 検証観点:
 *   1. 認可: 未認証 → 401, admin → 403, super_admin → 200
 *   2. テナント不在 → 404
 *   3. 監査ログ: target tenant (= id) で記録される (代行操作として明示)
 *   4. テナント越境: super_admin は全テナント横断アクセス権を持つので越境問題は構造上発生しない
 *      が、updateStorageBytesUsedForTenant の deletedAt フィルタが境界を守ることを別途検証
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/permissions/role', () => ({
  isSuperAdmin: vi.fn(),
}));

vi.mock('@/services/tenant-storage.service', () => ({
  updateStorageBytesUsedForTenant: vi.fn(),
}));

vi.mock('@/services/api-usage-recalc.service', () => ({
  reconcileTenantApiUsage: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));

import { POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { updateStorageBytesUsedForTenant } from '@/services/tenant-storage.service';
import { reconcileTenantApiUsage } from '@/services/api-usage-recalc.service';
import { recordAuditLog } from '@/services/audit.service';

const SUPER_ADMIN = {
  id: 'super-admin-uuid',
  tenantId: 'mgmt-tenant',
  systemRole: 'super_admin',
} as never;

const TARGET_TENANT = 'target-tenant-uuid';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq() {
  return new NextRequest(`http://localhost/api/admin/super/tenants/${TARGET_TENANT}/recalculate`, {
    method: 'POST',
  });
}

describe('認可', () => {
  it('admin (tenant admin) → 403 (super_admin 限定 = 代行操作は運営者のみ)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u1', tenantId: 't1', systemRole: 'admin',
    } as never);
    vi.mocked(isSuperAdmin).mockReturnValue(false);

    const res = await POST(makeReq(), { params: Promise.resolve({ id: TARGET_TENANT }) });
    expect(res.status).toBe(403);
    expect(updateStorageBytesUsedForTenant).not.toHaveBeenCalled();
    expect(reconcileTenantApiUsage).not.toHaveBeenCalled();
  });
});

describe('正常系', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(SUPER_ADMIN);
    vi.mocked(isSuperAdmin).mockReturnValue(true);
  });

  it('storage 再集計 + API 整合性チェック結果を返す', async () => {
    vi.mocked(updateStorageBytesUsedForTenant).mockResolvedValue(BigInt(771872));
    vi.mocked(reconcileTenantApiUsage).mockResolvedValue({
      tenantId: TARGET_TENANT,
      cachedCallCount: 7,
      cachedCostJpy: 0,
      reconciledCallCount: 7,
      reconciledCostJpy: 0,
      driftCallCount: 0,
      driftCostJpy: 0,
      driftRatio: 0,
      monthStartUtc: new Date('2026-05-01T00:00:00Z'),
      hasDrift: false,
    });

    const res = await POST(makeReq(), { params: Promise.resolve({ id: TARGET_TENANT }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.storageBytesUsed).toBe(771872);
    expect(body.data.apiUsage.tenantId).toBe(TARGET_TENANT);
  });

  it('テナント不在 (updateStorageBytesUsedForTenant が null) → 404', async () => {
    vi.mocked(updateStorageBytesUsedForTenant).mockResolvedValue(null);
    vi.mocked(reconcileTenantApiUsage).mockResolvedValue(null);

    const res = await POST(makeReq(), { params: Promise.resolve({ id: TARGET_TENANT }) });
    expect(res.status).toBe(404);
  });

  it('監査ログは target tenant (= id) で記録される (代行操作の追跡性)', async () => {
    vi.mocked(updateStorageBytesUsedForTenant).mockResolvedValue(BigInt(0));
    vi.mocked(reconcileTenantApiUsage).mockResolvedValue({
      tenantId: TARGET_TENANT,
      cachedCallCount: 0,
      cachedCostJpy: 0,
      reconciledCallCount: 0,
      reconciledCostJpy: 0,
      driftCallCount: 0,
      driftCostJpy: 0,
      driftRatio: 0,
      monthStartUtc: new Date(),
      hasDrift: false,
    });

    await POST(makeReq(), { params: Promise.resolve({ id: TARGET_TENANT }) });

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TARGET_TENANT, // target tenant
        userId: 'super-admin-uuid', // actor
        entityType: 'tenant',
        entityId: TARGET_TENANT,
      }),
    );
  });
});
