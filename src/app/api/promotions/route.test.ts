import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));
vi.mock('@/services/promotion.service', () => ({
  getPromotedIssues: vi.fn(),
  getSourceRisks: vi.fn(),
  getPromotedKnowledge: vi.fn(),
  getSourceIssues: vi.fn(),
}));

import { GET } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import {
  getPromotedIssues,
  getSourceRisks,
  getPromotedKnowledge,
  getSourceIssues,
} from '@/services/promotion.service';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function getReq(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/promotions${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', tenantId: TENANT_ID, systemRole: 'general' } as never);
});

describe('GET /api/promotions — 認可', () => {
  it('未認証は 401', async () => {
    const { NextResponse } = await import('next/server');
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 }) as never,
    );
    const res = await GET(getReq('?fromType=risk&fromId=r-1'));
    expect(res.status).toBe(401);
  });

  it('クエリパラメータの組が無い場合は 400', async () => {
    const res = await GET(getReq(''));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/promotions — クエリパターンの振り分け', () => {
  it('fromType=risk&fromId → getPromotedIssues', async () => {
    vi.mocked(getPromotedIssues).mockResolvedValue([{ id: 'i-1', title: 'T', visibility: 'public', promotedAt: 'x' }]);
    const res = await GET(getReq('?fromType=risk&fromId=r-1'));
    expect(res.status).toBe(200);
    expect(getPromotedIssues).toHaveBeenCalledWith('r-1', TENANT_ID);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
  });

  it('fromType=issue&fromId → getPromotedKnowledge', async () => {
    vi.mocked(getPromotedKnowledge).mockResolvedValue([]);
    const res = await GET(getReq('?fromType=issue&fromId=i-1'));
    expect(res.status).toBe(200);
    expect(getPromotedKnowledge).toHaveBeenCalledWith('i-1', TENANT_ID);
  });

  it('toType=issue&toId → getSourceRisks', async () => {
    vi.mocked(getSourceRisks).mockResolvedValue([]);
    const res = await GET(getReq('?toType=issue&toId=i-1'));
    expect(res.status).toBe(200);
    expect(getSourceRisks).toHaveBeenCalledWith('i-1', TENANT_ID);
  });

  it('toType=knowledge&toId → getSourceIssues', async () => {
    vi.mocked(getSourceIssues).mockResolvedValue([]);
    const res = await GET(getReq('?toType=knowledge&toId=k-1'));
    expect(res.status).toBe(200);
    expect(getSourceIssues).toHaveBeenCalledWith('k-1', TENANT_ID);
  });
});
