import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  requireStorageQuotaForWrite: vi.fn(async () => null),
}));
vi.mock('@/services/asset-link.service', () => ({
  createAssetLink: vi.fn(),
  getAssetLinks: vi.fn(),
}));
vi.mock('@/services/audit.service', () => ({
  recordAuditLog: vi.fn(),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (k: string) => k),
}));

import { GET, POST } from './route';
import { getAuthenticatedUser } from '@/lib/api-helpers';
import { createAssetLink, getAssetLinks } from '@/services/asset-link.service';
import { recordAuditLog } from '@/services/audit.service';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const RISK_ID = '00000000-0000-4000-8000-000000000001';
const KNOWLEDGE_ID = '00000000-0000-4000-8000-000000000002';

function getReq(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/asset-links${qs}`);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/asset-links', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const validBody = {
  fromEntityType: 'risk',
  fromEntityId: RISK_ID,
  toEntityType: 'knowledge',
  toEntityId: KNOWLEDGE_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', tenantId: TENANT_ID, systemRole: 'general' } as never);
});

describe('GET /api/asset-links', () => {
  it('未認証は 401', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 }) as never,
    );
    const res = await GET(getReq(`?entityType=risk&entityId=${RISK_ID}`));
    expect(res.status).toBe(401);
  });

  it('entityType / entityId 不足は 400', async () => {
    const res = await GET(getReq('?entityType=risk'));
    expect(res.status).toBe(400);
  });

  it('対象外の entityType (task 等) は 400', async () => {
    const res = await GET(getReq(`?entityType=task&entityId=${RISK_ID}`));
    expect(res.status).toBe(400);
  });

  it('成功時: getAssetLinks の結果を返す', async () => {
    vi.mocked(getAssetLinks).mockResolvedValue([
      { linkId: 'link-1', createdAt: 'x', createdBy: 'u-1', entity: { entityType: 'knowledge', entityId: KNOWLEDGE_ID, title: 'K', conductedDate: null, visibility: 'public' } },
    ]);
    const res = await GET(getReq(`?entityType=risk&entityId=${RISK_ID}`));
    expect(res.status).toBe(200);
    expect(getAssetLinks).toHaveBeenCalledWith('risk', RISK_ID, TENANT_ID);
    const json = await res.json();
    expect(json.data).toHaveLength(1);
  });
});

describe('POST /api/asset-links — 検証', () => {
  it('body 不正 (fromEntityId が uuid でない) は 400', async () => {
    const res = await POST(postReq({ ...validBody, fromEntityId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/asset-links — service エラーのマッピング', () => {
  it('SELF_LINK_FORBIDDEN → 400', async () => {
    vi.mocked(createAssetLink).mockRejectedValue(new Error('SELF_LINK_FORBIDDEN'));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('SELF_LINK_FORBIDDEN');
  });

  it('FROM_NOT_FOUND → 404 (NOT_FOUND)', async () => {
    vi.mocked(createAssetLink).mockRejectedValue(new Error('FROM_NOT_FOUND'));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('TO_NOT_FOUND → 404 (NOT_FOUND)', async () => {
    vi.mocked(createAssetLink).mockRejectedValue(new Error('TO_NOT_FOUND'));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });

  it('ALREADY_LINKED → 409', async () => {
    vi.mocked(createAssetLink).mockRejectedValue(new Error('ALREADY_LINKED'));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('ALREADY_LINKED');
  });

  it('想定外のエラーは re-throw される', async () => {
    vi.mocked(createAssetLink).mockRejectedValue(new Error('UNEXPECTED'));
    await expect(POST(postReq(validBody))).rejects.toThrow('UNEXPECTED');
  });
});

describe('POST /api/asset-links — 成功', () => {
  it('201 + 新規リンクを返し、audit log (CREATE/asset_link) を記録する', async () => {
    const link = { linkId: 'link-1', createdAt: 'x', createdBy: 'u-1', entity: { entityType: 'knowledge' as const, entityId: KNOWLEDGE_ID, title: 'K', conductedDate: null, visibility: 'public' } };
    vi.mocked(createAssetLink).mockResolvedValue(link);

    const res = await POST(postReq(validBody));

    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual(link);
    expect(createAssetLink).toHaveBeenCalledWith('risk', RISK_ID, 'knowledge', KNOWLEDGE_ID, 'u-1', TENANT_ID);
    expect(recordAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      userId: 'u-1',
      action: 'CREATE',
      entityType: 'asset_link',
      entityId: 'link-1',
    }));
  });
});
