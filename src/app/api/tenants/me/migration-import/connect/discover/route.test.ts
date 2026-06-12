import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
  requireAdmin: vi.fn(),
}));

const { discoverNotion } = vi.hoisted(() => ({ discoverNotion: vi.fn() }));
vi.mock('@/services/import/connectors/registry', async () => {
  const actual = await vi.importActual<typeof import('@/services/import/connectors/registry')>(
    '@/services/import/connectors/registry',
  );
  return {
    ...actual,
    CONNECTORS: { ...actual.CONNECTORS, notion: { discover: discoverNotion, fetchSources: vi.fn() } },
  };
});

import { POST } from './route';
import { getAuthenticatedUser, requireAdmin } from '@/lib/api-helpers';

const adminUser = { id: 'u1', tenantId: 't1', name: '', email: '', systemRole: 'admin' };

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/tenants/me/migration-import/connect/discover', {
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

describe('POST connect/discover', () => {
  it('未認証は透過', async () => {
    const unauth = NextResponse.json({ error: { code: 'UNAUTHORIZED' } }, { status: 401 });
    vi.mocked(getAuthenticatedUser).mockResolvedValue(unauth as never);
    const res = await POST(req({ source: 'notion', auth: { token: 't' } }));
    expect(res.status).toBe(401);
    expect(discoverNotion).not.toHaveBeenCalled();
  });

  it('admin でない → requireAdmin の 403 を返す', async () => {
    vi.mocked(requireAdmin).mockReturnValue(NextResponse.json({}, { status: 403 }) as never);
    const res = await POST(req({ source: 'notion', auth: { token: 't' } }));
    expect(res.status).toBe(403);
    expect(discoverNotion).not.toHaveBeenCalled();
  });

  it('未対応 source は INVALID_FORMAT', async () => {
    const res = await POST(req({ source: 'github', auth: { token: 't' } }));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe('INVALID_FORMAT');
  });

  it('token 無しは INVALID_FORMAT', async () => {
    const res = await POST(req({ source: 'notion', auth: {} }));
    expect((await res.json()).error.code).toBe('INVALID_FORMAT');
  });

  it('成功時は schema を返す (トークンは保存しない)', async () => {
    discoverNotion.mockResolvedValue({ source: 'notion', sources: [{ id: 'ds1', name: 'DB', fields: [] }], warnings: [] });
    const res = await POST(req({ source: 'notion', auth: { token: 'secret' } }));
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.schema.sources[0].id).toBe('ds1');
    expect(discoverNotion).toHaveBeenCalledWith({ token: 'secret' });
  });

  it('接続失敗は CONNECT_FAILED (200)', async () => {
    discoverNotion.mockRejectedValue(new Error('boom'));
    const res = await POST(req({ source: 'notion', auth: { token: 't' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).error.code).toBe('CONNECT_FAILED');
  });
});
