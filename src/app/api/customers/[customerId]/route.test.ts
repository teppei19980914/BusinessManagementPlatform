/**
 * GET / PATCH / DELETE /api/customers/[customerId] の認可テスト (2026-05-14)
 *
 * 検証観点:
 *   1. general → 403 (3 メソッド全て)
 *   2. admin → 200 (自テナントの Customer を CRUD)
 *   3. super_admin → 200 (管理テナントのシード Customer を CRUD する用途 / 2026-05-14 拡張)
 *
 * service 層のテナント分離テストは customer.service.test.ts で別途網羅済み。
 * 本テストは認可分岐のみに集中する。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  requireStorageQuotaForWrite: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/services/customer.service', () => ({
  getCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  deleteCustomer: vi.fn(),
  deleteCustomerCascade: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
  sanitizeForAudit: (v: unknown) => v,
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((k: string) => k),
}));

import { GET, PATCH, DELETE } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { getCustomer, updateCustomer, deleteCustomer } from '@/services/customer.service';

const params = Promise.resolve({ customerId: 'c-1' });

const customerDTO = {
  id: 'c-1',
  name: 'X 商事',
  department: null,
  contactPerson: null,
  contactEmail: null,
  notes: null,
  createdAt: '2026-05-14T00:00:00Z',
  updatedAt: '2026-05-14T00:00:00Z',
  activeProjectCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET — 認可', () => {
  it('general → 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u', tenantId: 't', name: '', email: '', systemRole: 'general',
    } as never);
    const req = new NextRequest('http://localhost/api/customers/c-1');
    const res = await GET(req, { params });
    expect(res.status).toBe(403);
    expect(getCustomer).not.toHaveBeenCalled();
  });

  it('admin → 200', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u', tenantId: 'tenant-A', name: '', email: '', systemRole: 'admin',
    } as never);
    vi.mocked(getCustomer).mockResolvedValue(customerDTO);
    const req = new NextRequest('http://localhost/api/customers/c-1');
    const res = await GET(req, { params });
    expect(res.status).toBe(200);
    expect(getCustomer).toHaveBeenCalledWith('c-1', 'tenant-A');
  });

  it('super_admin → 200 (管理テナントの Customer 取得 / 2026-05-14 拡張)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'super-1',
      tenantId: '00000000-0000-0000-0000-ffffffffffff',
      name: '',
      email: '',
      systemRole: 'super_admin',
    } as never);
    vi.mocked(getCustomer).mockResolvedValue(customerDTO);
    const req = new NextRequest('http://localhost/api/customers/c-1');
    const res = await GET(req, { params });
    expect(res.status).toBe(200);
    expect(getCustomer).toHaveBeenCalledWith('c-1', '00000000-0000-0000-0000-ffffffffffff');
  });
});

describe('PATCH — 認可', () => {
  const body = { name: 'X 商事 改名' };

  const buildReq = () =>
    new NextRequest('http://localhost/api/customers/c-1', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });

  it('general → 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u', tenantId: 't', name: '', email: '', systemRole: 'general',
    } as never);
    const res = await PATCH(buildReq(), { params });
    expect(res.status).toBe(403);
    expect(updateCustomer).not.toHaveBeenCalled();
  });

  it('super_admin → 200 (管理テナントの Customer 更新 / 2026-05-14 拡張)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'super-1',
      tenantId: '00000000-0000-0000-0000-ffffffffffff',
      name: '',
      email: '',
      systemRole: 'super_admin',
    } as never);
    vi.mocked(getCustomer).mockResolvedValue(customerDTO);
    vi.mocked(updateCustomer).mockResolvedValue({ ...customerDTO, name: 'X 商事 改名' });
    const res = await PATCH(buildReq(), { params });
    expect(res.status).toBe(200);
    expect(updateCustomer).toHaveBeenCalledWith(
      'c-1',
      expect.objectContaining({ name: 'X 商事 改名' }),
      'super-1',
      '00000000-0000-0000-0000-ffffffffffff',
    );
  });
});

describe('DELETE — 認可', () => {
  const buildReq = () =>
    new NextRequest('http://localhost/api/customers/c-1', { method: 'DELETE' });

  it('general → 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u', tenantId: 't', name: '', email: '', systemRole: 'general',
    } as never);
    const res = await DELETE(buildReq(), { params });
    expect(res.status).toBe(403);
    expect(deleteCustomer).not.toHaveBeenCalled();
  });

  it('super_admin → 200 (管理テナントの Customer 物理削除 / 2026-05-14 拡張)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'super-1',
      tenantId: '00000000-0000-0000-0000-ffffffffffff',
      name: '',
      email: '',
      systemRole: 'super_admin',
    } as never);
    vi.mocked(getCustomer).mockResolvedValue(customerDTO);
    vi.mocked(deleteCustomer).mockResolvedValue({ ok: true });
    const res = await DELETE(buildReq(), { params });
    expect(res.status).toBe(200);
    expect(deleteCustomer).toHaveBeenCalledWith('c-1', '00000000-0000-0000-0000-ffffffffffff');
  });
});
