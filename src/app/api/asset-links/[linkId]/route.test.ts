import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));
vi.mock('@/services/asset-link.service', () => ({
  deleteAssetLink: vi.fn(),
}));
vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
}));

import { DELETE } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { deleteAssetLink } from '@/services/asset-link.service';
import { recordAuditLog } from '@/services/audit.service';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function mockParams(linkId: string) {
  return { params: Promise.resolve({ linkId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', tenantId: TENANT_ID, systemRole: 'general' } as never);
});

describe('DELETE /api/asset-links/[linkId]', () => {
  it('未認証は 401', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 }) as never,
    );
    const res = await DELETE(new Request('http://localhost/x') as never, mockParams('link-1'));
    expect(res.status).toBe(401);
  });

  it('存在しない/他人/他テナントのリンクは 404 (403 と区別しない)', async () => {
    vi.mocked(deleteAssetLink).mockResolvedValue(false);
    const res = await DELETE(new Request('http://localhost/x') as never, mockParams('link-1'));
    expect(res.status).toBe(404);
    expect(recordAuditLog).not.toHaveBeenCalled();
  });

  it('作成者本人の削除は成功し、audit log (DELETE/asset_link) を記録する', async () => {
    vi.mocked(deleteAssetLink).mockResolvedValue(true);
    const res = await DELETE(new Request('http://localhost/x') as never, mockParams('link-1'));
    expect(res.status).toBe(200);
    expect(deleteAssetLink).toHaveBeenCalledWith('link-1', 'u-1', TENANT_ID);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      userId: 'u-1',
      action: 'DELETE',
      entityType: 'asset_link',
      entityId: 'link-1',
    }));
  });
});
