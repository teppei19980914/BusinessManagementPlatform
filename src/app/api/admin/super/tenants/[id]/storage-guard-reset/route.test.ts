/**
 * POST /api/admin/super/tenants/[id]/storage-guard-reset の単体テスト (ADR-0020 / 2026-05-25)
 *
 * 検証観点:
 *   - super_admin 認可 (super_admin 以外は 403)
 *   - circuit open 中: reset 成功 + audit_log + recordError
 *   - circuit not open: 409 CIRCUIT_NOT_OPEN
 *   - テナント不在: 404
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

vi.mock('@/lib/permissions/role', () => ({
  isSuperAdmin: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    tenant: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('@/services/error-log.service', () => ({
  recordError: vi.fn(),
}));

import { POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { isSuperAdmin } from '@/lib/permissions/role';
import { prisma } from '@/lib/db';
import { recordError } from '@/services/error-log.service';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

function makeReq(): NextRequest {
  return new NextRequest(
    `http://localhost/api/admin/super/tenants/${TENANT_ID}/storage-guard-reset`,
    { method: 'POST' },
  );
}

const ctx = { params: Promise.resolve({ id: TENANT_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST storage-guard-reset', () => {
  it('未認証 → NextResponse (api-helpers から返却)', async () => {
    const errResponse = NextResponse.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce(errResponse as never);

    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(401);
  });

  it('super_admin 以外 → 403 FORBIDDEN', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce({ id: USER_ID } as never);
    vi.mocked(isSuperAdmin).mockReturnValueOnce(false);

    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('対象が MANAGEMENT_TENANT_ID → 403 MANAGEMENT_TENANT_FORBIDDEN (G-4 4 回目検証)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce({ id: USER_ID } as never);
    vi.mocked(isSuperAdmin).mockReturnValueOnce(true);

    // src/lib/tenant.ts の MANAGEMENT_TENANT_ID 実値
    const MANAGEMENT_ID = '00000000-0000-0000-0000-ffffffffffff';
    const req = new NextRequest(
      `http://localhost/api/admin/super/tenants/${MANAGEMENT_ID}/storage-guard-reset`,
      { method: 'POST' },
    );
    const res = await POST(req, { params: Promise.resolve({ id: MANAGEMENT_ID }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('MANAGEMENT_TENANT_FORBIDDEN');
    // テナント検索すら走らないこと (= 早期 return)
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });

  it('テナント不在 → 404', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce({ id: USER_ID } as never);
    vi.mocked(isSuperAdmin).mockReturnValueOnce(true);
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce(null);

    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(404);
  });

  it('circuit open でない (openedAt=null) → 409 CIRCUIT_NOT_OPEN', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce({ id: USER_ID } as never);
    vi.mocked(isSuperAdmin).mockReturnValueOnce(true);
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      storageGuardCircuitFailCount: 0,
      storageGuardCircuitOpenedAt: null,
    } as never);

    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('CIRCUIT_NOT_OPEN');
  });

  it('circuit open 中 → 200 で reset 完了 + audit_log + recordError', async () => {
    const openedAt = new Date('2026-05-25T10:00:00Z');
    vi.mocked(getAuthenticatedUser).mockResolvedValueOnce({ id: USER_ID } as never);
    vi.mocked(isSuperAdmin).mockReturnValueOnce(true);
    vi.mocked(prisma.tenant.findFirst).mockResolvedValueOnce({
      id: TENANT_ID,
      storageGuardCircuitFailCount: 5,
      storageGuardCircuitOpenedAt: openedAt,
    } as never);
    vi.mocked(prisma.$transaction).mockResolvedValueOnce([{}, {}] as never);

    const res = await POST(makeReq(), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tenantId).toBe(TENANT_ID);
    expect(body.data.previousFailCount).toBe(5);
    expect(body.data.previousOpenedAt).toBe(openedAt.toISOString());

    // 2 operations in transaction: tenant update + audit_log create
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'info',
        context: expect.objectContaining({ kind: 'storage_guard_circuit_reset' }),
      }),
    );
  });
});

