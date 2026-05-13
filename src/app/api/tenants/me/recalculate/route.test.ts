/**
 * POST /api/tenants/me/recalculate (2026-05-14)
 *
 * 検証観点:
 *   1. 認可: general → 403, admin → 200, super_admin → 200
 *   2. **テナント越境防止 (severity-1 個人情報漏洩予防)**:
 *      - URL に tenantId を一切受けない (POST body も無視)
 *      - service 層には必ず session.user.tenantId が渡る
 *      - 別テナントの id を渡す手段が存在しないことを構造的に検証
 *   3. テナント不在 → 404
 *   4. 監査ログ: 自テナント (session.tenantId) で記録される
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/permissions/role', () => ({
  isAdminOrAbove: vi.fn(),
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
import { isAdminOrAbove } from '@/lib/permissions/role';
import { updateStorageBytesUsedForTenant } from '@/services/tenant-storage.service';
import { reconcileTenantApiUsage } from '@/services/api-usage-recalc.service';
import { recordAuditLog } from '@/services/audit.service';

const OWN_TENANT = 'own-tenant-uuid';
const OTHER_TENANT = 'other-tenant-uuid';

const TENANT_ADMIN = {
  id: 'admin-user',
  tenantId: OWN_TENANT,
  systemRole: 'admin',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('認可', () => {
  it('general → 403 (admin 以上のみ許可)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u1', tenantId: OWN_TENANT, systemRole: 'general',
    } as never);
    vi.mocked(isAdminOrAbove).mockReturnValue(false);

    const req = new NextRequest('http://localhost/api/tenants/me/recalculate', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(updateStorageBytesUsedForTenant).not.toHaveBeenCalled();
  });
});

describe('正常系 (tenant admin)', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(TENANT_ADMIN);
    vi.mocked(isAdminOrAbove).mockReturnValue(true);
  });

  it('storage 再集計 + API 整合性チェック結果を返す', async () => {
    vi.mocked(updateStorageBytesUsedForTenant).mockResolvedValue(BigInt(123456));
    vi.mocked(reconcileTenantApiUsage).mockResolvedValue({
      tenantId: OWN_TENANT,
      cachedCallCount: 5,
      cachedCostJpy: 50,
      reconciledCallCount: 5,
      reconciledCostJpy: 50,
      driftCallCount: 0,
      driftCostJpy: 0,
      driftRatio: 0,
      monthStartUtc: new Date(),
      hasDrift: false,
    });

    const req = new NextRequest('http://localhost/api/tenants/me/recalculate', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it('テナント不在 → 404', async () => {
    vi.mocked(updateStorageBytesUsedForTenant).mockResolvedValue(null);
    vi.mocked(reconcileTenantApiUsage).mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/tenants/me/recalculate', { method: 'POST' });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });
});

// ================================================================
// テナント越境防止 (severity-1)
// ================================================================

describe('[テナント越境防止] URL params / body で他テナント id を渡しても自テナントに固定される', () => {
  beforeEach(() => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(TENANT_ADMIN);
    vi.mocked(isAdminOrAbove).mockReturnValue(true);
    vi.mocked(updateStorageBytesUsedForTenant).mockResolvedValue(BigInt(100));
    vi.mocked(reconcileTenantApiUsage).mockResolvedValue({
      tenantId: OWN_TENANT,
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
  });

  it('POST body に { tenantId: OTHER_TENANT } を送っても無視され、service 層に渡るのは OWN_TENANT', async () => {
    const req = new NextRequest('http://localhost/api/tenants/me/recalculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: OTHER_TENANT }),
    });
    await POST(req);

    // service 層には session.user.tenantId (= OWN_TENANT) のみ渡る
    expect(updateStorageBytesUsedForTenant).toHaveBeenCalledWith(OWN_TENANT);
    expect(updateStorageBytesUsedForTenant).not.toHaveBeenCalledWith(OTHER_TENANT);
    expect(reconcileTenantApiUsage).toHaveBeenCalledWith(OWN_TENANT);
    expect(reconcileTenantApiUsage).not.toHaveBeenCalledWith(OTHER_TENANT);
  });

  it('URL query に ?tenantId=OTHER を付けても無視される', async () => {
    const req = new NextRequest(
      `http://localhost/api/tenants/me/recalculate?tenantId=${OTHER_TENANT}`,
      { method: 'POST' },
    );
    await POST(req);

    expect(updateStorageBytesUsedForTenant).toHaveBeenCalledWith(OWN_TENANT);
    expect(updateStorageBytesUsedForTenant).not.toHaveBeenCalledWith(OTHER_TENANT);
  });

  it('監査ログは必ず session の自テナントで記録される (代行記録と区別)', async () => {
    const req = new NextRequest('http://localhost/api/tenants/me/recalculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: OTHER_TENANT }),
    });
    await POST(req);

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: OWN_TENANT, // 自テナント
        userId: 'admin-user',
        entityType: 'tenant',
        entityId: OWN_TENANT,
      }),
    );
  });
});
