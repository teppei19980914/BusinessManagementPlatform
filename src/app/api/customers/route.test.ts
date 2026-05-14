/**
 * GET / POST /api/customers の認可テスト (2026-05-14)
 *
 * 検証観点:
 *   1. 未認証 → 401 透過
 *   2. general → 403
 *   3. admin → 200 (テナント管理者は自テナントの Customer を CRUD)
 *   4. super_admin → 200 (管理テナントのシード Customer を CRUD する用途)
 *
 * 設計判断:
 *   - 認可ヘルパ `isAdminOrAbove` (src/lib/permissions/role.ts) で判定済み。
 *     本テストはルートが正しく当該ヘルパで分岐していることを保証する。
 *   - service 層 (`listCustomers` / `createCustomer`) はモックし、認可分岐のみに集中。
 *   - サービスの tenantId 分離テストは customer.service.test.ts で別途網羅済み。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  requireStorageQuotaForWrite: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/services/customer.service', () => ({
  listCustomers: vi.fn(),
  createCustomer: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
  sanitizeForAudit: (v: unknown) => v,
}));

// next-intl の getTranslations を最小実装でモック (forbidden() などで使用)
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((k: string) => k),
}));

import { GET, POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { listCustomers, createCustomer } from '@/services/customer.service';

const buildPostReq = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/customers', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/customers — 認可', () => {
  it('未認証 → 401 透過', async () => {
    const unauthRes = NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    vi.mocked(getAuthenticatedUser).mockResolvedValue(unauthRes);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(listCustomers).not.toHaveBeenCalled();
  });

  it('general → 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u', tenantId: 't', name: '', email: '', systemRole: 'general',
    } as never);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(listCustomers).not.toHaveBeenCalled();
  });

  it('admin → 200 (テナント管理者は自テナントの Customer を取得)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u', tenantId: 'tenant-A', name: '', email: '', systemRole: 'admin',
    } as never);
    vi.mocked(listCustomers).mockResolvedValue([]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(listCustomers).toHaveBeenCalledWith('tenant-A');
  });

  it('super_admin → 200 (管理テナントの Customer を取得 / 2026-05-14 拡張)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'super-1',
      tenantId: '00000000-0000-0000-0000-ffffffffffff',
      name: '',
      email: '',
      systemRole: 'super_admin',
    } as never);
    vi.mocked(listCustomers).mockResolvedValue([]);
    const res = await GET();
    expect(res.status).toBe(200);
    // super_admin の tenantId (= 管理テナント) で listCustomers が呼ばれる
    expect(listCustomers).toHaveBeenCalledWith('00000000-0000-0000-0000-ffffffffffff');
  });
});

describe('POST /api/customers — 認可', () => {
  const validBody = { name: 'X 商事', department: null, contactPerson: null, contactEmail: null, notes: null };

  it('general → 403 (createCustomer は呼ばれない)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u', tenantId: 't', name: '', email: '', systemRole: 'general',
    } as never);
    const res = await POST(buildPostReq(validBody));
    expect(res.status).toBe(403);
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('admin → 201 (自テナントに Customer 作成)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u', tenantId: 'tenant-A', name: '', email: '', systemRole: 'admin',
    } as never);
    vi.mocked(createCustomer).mockResolvedValue({
      id: 'new-c', name: 'X 商事', department: null, contactPerson: null,
      contactEmail: null, notes: null, createdAt: '2026-05-14T00:00:00Z',
      updatedAt: '2026-05-14T00:00:00Z', activeProjectCount: 0,
    });
    const res = await POST(buildPostReq(validBody));
    expect(res.status).toBe(201);
    expect(createCustomer).toHaveBeenCalledWith(expect.any(Object), 'u', 'tenant-A');
  });

  it('super_admin → 201 (管理テナントに Customer 作成 / 2026-05-14 拡張)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'super-1',
      tenantId: '00000000-0000-0000-0000-ffffffffffff',
      name: '',
      email: '',
      systemRole: 'super_admin',
    } as never);
    vi.mocked(createCustomer).mockResolvedValue({
      id: 'new-c', name: 'X 商事', department: null, contactPerson: null,
      contactEmail: null, notes: null, createdAt: '2026-05-14T00:00:00Z',
      updatedAt: '2026-05-14T00:00:00Z', activeProjectCount: 0,
    });
    const res = await POST(buildPostReq(validBody));
    expect(res.status).toBe(201);
    expect(createCustomer).toHaveBeenCalledWith(
      expect.any(Object),
      'super-1',
      '00000000-0000-0000-0000-ffffffffffff',
    );
  });
});
