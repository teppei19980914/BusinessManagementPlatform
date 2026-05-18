/**
 * /api/admin/super/stripe-dlq/usage/[id]/retry POST テスト
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockGetAuthenticatedUser = vi.fn();
vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: () => mockGetAuthenticatedUser(),
}));

const mockIsSuperAdmin = vi.fn();
vi.mock('@/lib/permissions/role', () => ({
  isSuperAdmin: (u: unknown) => mockIsSuperAdmin(u),
}));

vi.mock('@/services/stripe-dlq.service', () => ({
  retryUsageQueueRow: vi.fn(),
}));

import { POST } from './route';
import { retryUsageQueueRow } from '@/services/stripe-dlq.service';

function buildReq(): NextRequest {
  return new NextRequest('http://localhost/api/admin/super/stripe-dlq/usage/q_1/retry', {
    method: 'POST',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthenticatedUser.mockResolvedValue({ id: 'super-id', tenantId: 'mgmt' });
  mockIsSuperAdmin.mockReturnValue(true);
});

describe('POST /api/admin/super/stripe-dlq/usage/[id]/retry', () => {
  it('未認証 → 401 伝播', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce(
      NextResponse.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 }),
    );
    const res = await POST(buildReq(), { params: Promise.resolve({ id: 'q_1' }) });
    expect(res.status).toBe(401);
  });

  it('super_admin 以外 → 403', async () => {
    mockIsSuperAdmin.mockReturnValueOnce(false);
    const res = await POST(buildReq(), { params: Promise.resolve({ id: 'q_1' }) });
    expect(res.status).toBe(403);
  });

  it('正常: ok 200', async () => {
    vi.mocked(retryUsageQueueRow).mockResolvedValue({ ok: true, id: 'q_1' });
    const res = await POST(buildReq(), { params: Promise.resolve({ id: 'q_1' }) });
    expect(res.status).toBe(200);
    expect(retryUsageQueueRow).toHaveBeenCalledWith('q_1', 'super-id');
  });

  it('row 不在 → 404', async () => {
    vi.mocked(retryUsageQueueRow).mockResolvedValue({ ok: false, error: 'ROW_NOT_FOUND' });
    const res = await POST(buildReq(), { params: Promise.resolve({ id: 'q_x' }) });
    expect(res.status).toBe(404);
  });

  it('既送信 → 409', async () => {
    vi.mocked(retryUsageQueueRow).mockResolvedValue({ ok: false, error: 'ALREADY_SENT' });
    const res = await POST(buildReq(), { params: Promise.resolve({ id: 'q_x' }) });
    expect(res.status).toBe(409);
  });
});
