import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  requireAdmin: vi.fn(),
}));

const { fetchNotion } = vi.hoisted(() => ({ fetchNotion: vi.fn() }));
vi.mock('@/services/import/connectors/registry', async () => {
  const actual = await vi.importActual<typeof import('@/services/import/connectors/registry')>(
    '@/services/import/connectors/registry',
  );
  return {
    ...actual,
    CONNECTORS: { ...actual.CONNECTORS, notion: { discover: vi.fn(), fetchSources: fetchNotion } },
  };
});

vi.mock('@/services/import/migration-import.service', () => ({
  previewMigrationFromSources: vi.fn(),
}));

import { POST } from './route';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';
import { previewMigrationFromSources } from '@/services/import/migration-import.service';

const adminUser = { id: 'u1', tenantId: 't1', name: '', email: '', systemRole: 'admin' };
const validMapping = { mappings: [{ sourceId: 'ds1', entity: 'risk', columnMap: { title: '件名' } }] };

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/tenants/me/migration-import/connect/preview', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue(adminUser as never);
  vi.mocked(requireAdmin).mockReturnValue(null as never);
});

describe('POST connect/preview', () => {
  it('未認証は透過', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue(NextResponse.json({}, { status: 401 }) as never);
    const res = await POST(req({ source: 'notion', auth: { token: 't' }, mapping: validMapping }));
    expect(res.status).toBe(401);
    expect(fetchNotion).not.toHaveBeenCalled();
  });

  it('mapping 無しは INVALID_FORMAT', async () => {
    const res = await POST(req({ source: 'notion', auth: { token: 't' }, mapping: { mappings: [] } }));
    expect((await res.json()).error.code).toBe('INVALID_FORMAT');
    expect(fetchNotion).not.toHaveBeenCalled();
  });

  it('取得 → previewMigrationFromSources に sources+warnings を渡し previewId を返す', async () => {
    fetchNotion.mockResolvedValue({ sources: [{ entity: 'risk', rows: [], columnMap: {} }], warnings: ['w1'] });
    vi.mocked(previewMigrationFromSources).mockResolvedValue({
      ok: true,
      previewId: 'pv1',
      preview: { summary: {}, errors: [], warnings: [] } as never,
      expiresAt: '2026-06-13T00:00:00Z',
    });
    const res = await POST(req({ source: 'notion', auth: { token: 'secret' }, mapping: validMapping }));
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.previewId).toBe('pv1');
    expect(vi.mocked(previewMigrationFromSources).mock.calls[0][0]).toMatchObject({
      tenantId: 't1',
      userId: 'u1',
      warnings: ['w1'],
    });
  });

  it('取得失敗は FETCH_FAILED', async () => {
    fetchNotion.mockRejectedValue(new Error('boom'));
    const res = await POST(req({ source: 'notion', auth: { token: 't' }, mapping: validMapping }));
    expect((await res.json()).error.code).toBe('FETCH_FAILED');
    expect(previewMigrationFromSources).not.toHaveBeenCalled();
  });

  it('TOO_MANY_ROWS は 200+ok:false', async () => {
    fetchNotion.mockResolvedValue({ sources: [], warnings: [] });
    vi.mocked(previewMigrationFromSources).mockResolvedValue({ ok: false, error: 'TOO_MANY_ROWS', message: '多すぎ' });
    const res = await POST(req({ source: 'notion', auth: { token: 't' }, mapping: validMapping }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);
  });
});
