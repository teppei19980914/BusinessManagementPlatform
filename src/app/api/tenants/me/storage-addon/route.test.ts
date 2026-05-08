/**
 * /api/tenants/me/storage-addon route テスト (Phase 2 / 2026-05-08)
 *
 * 主に R-2 (PHASE2_THREAT_MODEL.md): プラン変更 / 予約キャンセルの監査ログ記録を検証。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/permissions', () => ({
  isTenantAdmin: vi.fn(),
}));

vi.mock('@/services/tenant-storage.service', () => ({
  getStorageInfo: vi.fn(),
  updateStorageAddonPlan: vi.fn(),
  cancelScheduledStorageAddon: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));

import { PATCH, DELETE } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isTenantAdmin } from '@/lib/permissions';
import {
  getStorageInfo,
  updateStorageAddonPlan,
  cancelScheduledStorageAddon,
} from '@/services/tenant-storage.service';
import { recordAuditLog } from '@/services/audit.service';

const TENANT_ID = 'tenant-uuid-1';
const USER_ID = 'user-uuid-1';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({
    id: USER_ID,
    tenantId: TENANT_ID,
    systemRole: 'admin',
  } as never);
  vi.mocked(isTenantAdmin).mockReturnValue(true);
});

describe('PATCH /api/tenants/me/storage-addon', () => {
  it('R-2: アップグレード成功時に recordAuditLog が before/after 付きで呼ばれる', async () => {
    vi.mocked(getStorageInfo).mockResolvedValue({
      tenantId: TENANT_ID,
      llmPlan: 'expert',
      storageAddonPlan: 'standard',
      storageAddonMonthlyJpy: 0,
      storageBytesUsed: 50 * 1024 * 1024,
      storageLimitBytes: 150 * 1024 * 1024,
      usageRatio: 0.33,
      graceState: 'active',
      graceStartedAt: null,
      graceDaysRemaining: null,
      scheduledStorageAddonAt: null,
      scheduledNextStorageAddon: null,
      storageBytesUsedAt: null,
    } as never);
    vi.mocked(updateStorageAddonPlan).mockResolvedValue({
      ok: true,
      appliedImmediately: true,
      scheduledFor: null,
    });

    const req = new NextRequest('http://localhost/api/tenants/me/storage-addon', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'plus' }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);

    expect(recordAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(recordAuditLog).mock.calls[0]![0];
    expect(call.userId).toBe(USER_ID);
    expect(call.action).toBe('UPDATE');
    expect(call.entityType).toBe('tenant_storage_addon');
    expect(call.entityId).toBe(TENANT_ID);
    expect(call.beforeValue).toMatchObject({
      storageAddonPlan: 'standard',
      storageAddonMonthlyJpy: 0,
    });
    expect(call.afterValue).toMatchObject({
      requestedPlan: 'plus',
      appliedImmediately: true,
    });
  });

  it('R-2: ダウングレード予約成功時にも audit log + scheduledFor が記録される', async () => {
    const futureDate = new Date('2026-06-01T00:00:00Z');
    vi.mocked(getStorageInfo).mockResolvedValue({
      tenantId: TENANT_ID,
      llmPlan: 'expert',
      storageAddonPlan: 'plus',
      storageAddonMonthlyJpy: 500,
      storageBytesUsed: 50 * 1024 * 1024,
      storageLimitBytes: 350 * 1024 * 1024,
      usageRatio: 0.14,
      graceState: 'active',
      graceStartedAt: null,
      graceDaysRemaining: null,
      scheduledStorageAddonAt: null,
      scheduledNextStorageAddon: null,
      storageBytesUsedAt: null,
    } as never);
    vi.mocked(updateStorageAddonPlan).mockResolvedValue({
      ok: true,
      appliedImmediately: false,
      scheduledFor: futureDate,
    });

    const req = new NextRequest('http://localhost/api/tenants/me/storage-addon', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'standard' }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);

    expect(recordAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(recordAuditLog).mock.calls[0]![0];
    expect(call.afterValue).toMatchObject({
      requestedPlan: 'standard',
      appliedImmediately: false,
      scheduledFor: futureDate.toISOString(),
    });
  });

  it('updateStorageAddonPlan が DOWNGRADE_BLOCKED_BY_USAGE を返した場合、audit ログは記録されない', async () => {
    vi.mocked(getStorageInfo).mockResolvedValue({} as never);
    vi.mocked(updateStorageAddonPlan).mockResolvedValue({
      ok: false,
      error: 'DOWNGRADE_BLOCKED_BY_USAGE',
      message: '使用量超過',
    });

    const req = new NextRequest('http://localhost/api/tenants/me/storage-addon', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'standard' }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(422);
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it('admin role なし → 403、audit ログ未記録', async () => {
    vi.mocked(isTenantAdmin).mockReturnValue(false);
    const req = new NextRequest('http://localhost/api/tenants/me/storage-addon', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'plus' }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(403);
    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/tenants/me/storage-addon', () => {
  it('R-2: 予約キャンセル時に audit ログが記録される (entityType=tenant_storage_addon_cancel)', async () => {
    const scheduledDate = new Date('2026-06-01T00:00:00Z');
    vi.mocked(getStorageInfo).mockResolvedValue({
      tenantId: TENANT_ID,
      llmPlan: 'expert',
      storageAddonPlan: 'plus',
      storageAddonMonthlyJpy: 500,
      storageBytesUsed: 0,
      storageLimitBytes: 350 * 1024 * 1024,
      usageRatio: 0,
      graceState: 'active',
      graceStartedAt: null,
      graceDaysRemaining: null,
      scheduledStorageAddonAt: scheduledDate,
      scheduledNextStorageAddon: 'standard',
      storageBytesUsedAt: null,
    } as never);
    vi.mocked(cancelScheduledStorageAddon).mockResolvedValue();

    const res = await DELETE();
    expect(res.status).toBe(200);

    expect(cancelScheduledStorageAddon).toHaveBeenCalledWith(TENANT_ID);
    expect(recordAuditLog).toHaveBeenCalledTimes(1);
    const call = vi.mocked(recordAuditLog).mock.calls[0]![0];
    expect(call.userId).toBe(USER_ID);
    expect(call.action).toBe('UPDATE');
    expect(call.entityType).toBe('tenant_storage_addon_cancel');
    expect(call.beforeValue).toMatchObject({
      scheduledStorageAddonAt: scheduledDate.toISOString(),
      scheduledNextStorageAddon: 'standard',
    });
    expect(call.afterValue).toBeNull();
  });

  it('admin role なし → 403、cancel/audit 未呼出', async () => {
    vi.mocked(isTenantAdmin).mockReturnValue(false);
    const res = await DELETE();
    expect(res.status).toBe(403);
    expect(cancelScheduledStorageAddon).not.toHaveBeenCalled();
    expect(recordAuditLog).not.toHaveBeenCalled();
  });
});
