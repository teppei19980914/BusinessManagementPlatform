/**
 * POST /api/projects の認可テスト (2026-05-14)
 *
 * 検証観点:
 *   1. 未認証 → 401 透過
 *   2. general → 403
 *   3. admin → 201 (テナント管理者は自テナントに Project 作成)
 *   4. super_admin → 201 (管理テナントのシード Project 追加投入用 / 2026-05-14 拡張)
 *
 * 設計判断:
 *   - 旧仕様: `systemRole !== 'admin'` で super_admin もブロックされていた (MVP-1a 制約)。
 *   - 新仕様: Customer (PR #364) と同じ `isAdminOrAbove(user)` に統一。super_admin が
 *     `/projects` 画面からシード Project の追加・修正を UI で行えるようにする。
 *   - service 層 `createProject` は引数 `tenantId` を素直に使うので、super_admin の
 *     `tenantId = MANAGEMENT_TENANT_ID` が自動で管理テナントスコープになる。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  requireStorageQuotaForWrite: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/services/project.service', () => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
}));

vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
  sanitizeForAudit: (v: unknown) => v,
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((k: string) => k),
}));

import { POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { createProject } from '@/services/project.service';

const VALID_BODY = {
  name: 'シードプロジェクト A',
  // createProjectSchema (src/lib/validators/project.ts) の必須項目を満たす最小構成
  customerId: '11111111-2222-4333-8444-555555555555',
  purpose: '目的',
  background: '背景',
  scope: 'スコープ',
  devMethod: 'scratch' as const,
  plannedStartDate: '2026-06-01',
  plannedEndDate: '2026-12-31',
};

const buildReq = () =>
  new NextRequest('http://localhost/api/projects', {
    method: 'POST',
    body: JSON.stringify(VALID_BODY),
    headers: { 'content-type': 'application/json' },
  });

const projectDto = {
  id: 'p-new', name: VALID_BODY.name,
  customerName: null, customerId: null,
  status: 'planning', deletedAt: null,
  isSampleData: false,
  plannedStartDate: '2026-06-01', plannedEndDate: '2026-12-31',
  actualStartDate: null, actualEndDate: null,
  contractType: null, devMethod: VALID_BODY.devMethod,
  scope: VALID_BODY.scope, outOfScope: null,
  purpose: VALID_BODY.purpose, background: VALID_BODY.background,
  techStackTags: [], businessDomainTags: [], processTags: [],
  createdAt: '2026-05-14T00:00:00Z', updatedAt: '2026-05-14T00:00:00Z',
  createdBy: '', updatedBy: '',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/projects — 認可', () => {
  it('未認証 → 401 透過 (createProject は呼ばれない)', async () => {
    const unauthRes = NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    vi.mocked(getAuthenticatedUser).mockResolvedValue(unauthRes);
    const res = await POST(buildReq());
    expect(res.status).toBe(401);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('general → 403', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'u', tenantId: 't', name: '', email: '', systemRole: 'general',
    } as never);
    const res = await POST(buildReq());
    expect(res.status).toBe(403);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('admin → 201 (自テナントに Project 作成)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'admin-1', tenantId: 'tenant-A', name: '', email: '', systemRole: 'admin',
    } as never);
    vi.mocked(createProject).mockResolvedValue(projectDto as never);
    const res = await POST(buildReq());
    expect(res.status).toBe(201);
    expect(createProject).toHaveBeenCalledWith(expect.any(Object), 'admin-1', 'tenant-A');
  });

  it('super_admin → 201 (管理テナントに Project 作成 / 2026-05-14 拡張)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({
      id: 'super-1',
      tenantId: '00000000-0000-0000-0000-ffffffffffff',
      name: '',
      email: '',
      systemRole: 'super_admin',
    } as never);
    vi.mocked(createProject).mockResolvedValue(projectDto as never);
    const res = await POST(buildReq());
    expect(res.status).toBe(201);
    expect(createProject).toHaveBeenCalledWith(
      expect.any(Object),
      'super-1',
      '00000000-0000-0000-0000-ffffffffffff',
    );
  });
});
