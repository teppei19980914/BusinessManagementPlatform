import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));
vi.mock('@/services/asset-link.service', () => ({
  searchLinkCandidates: vi.fn(),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
}));

import { GET } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { searchLinkCandidates } from '@/services/asset-link.service';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function getReq(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/asset-links/candidates${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', tenantId: TENANT_ID, systemRole: 'general' } as never);
});

describe('GET /api/asset-links/candidates', () => {
  it('未認証は 401', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 }) as never,
    );
    const res = await GET(getReq('?entityType=risk'));
    expect(res.status).toBe(401);
  });

  it('entityType 未指定は 400', async () => {
    const res = await GET(getReq(''));
    expect(res.status).toBe(400);
  });

  it('entityType が対象外 (task 等) は 400', async () => {
    const res = await GET(getReq('?entityType=task'));
    expect(res.status).toBe(400);
  });

  it('query 未指定時は空文字で service を呼ぶ', async () => {
    vi.mocked(searchLinkCandidates).mockResolvedValue([]);
    await GET(getReq('?entityType=knowledge'));
    expect(searchLinkCandidates).toHaveBeenCalledWith('knowledge', '', TENANT_ID, undefined);
  });

  it('query + excludeEntityId を service にそのまま渡す', async () => {
    vi.mocked(searchLinkCandidates).mockResolvedValue([]);
    await GET(getReq('?entityType=memo&query=foo&excludeEntityId=m-self'));
    expect(searchLinkCandidates).toHaveBeenCalledWith('memo', 'foo', TENANT_ID, 'm-self');
  });

  it('成功時: service の結果を data として返す', async () => {
    vi.mocked(searchLinkCandidates).mockResolvedValue([
      { entityType: 'memo', entityId: 'm-1', title: 'M', conductedDate: null, visibility: 'public' },
    ]);
    const res = await GET(getReq('?entityType=memo'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
  });
});
