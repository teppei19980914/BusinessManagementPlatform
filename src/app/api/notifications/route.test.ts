import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  prisma: {
    notification: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

import { GET } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.notification.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.notification.count).mockResolvedValue(0 as never);
});

function getReq(qs: string = ''): NextRequest {
  return new NextRequest(`http://localhost/api/notifications${qs}`);
}

describe('GET /api/notifications', () => {
  it('未認証は 401', async () => {
    const { NextResponse } = await import('next/server');
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 }) as never,
    );
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it('認証済は自分の通知 + unreadCount を返す', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', systemRole: 'general' } as never);
    vi.mocked(prisma.notification.count).mockResolvedValue(2 as never);

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.unreadCount).toBe(2);
    // user の自分の通知だけ取得
    const findCall = vi.mocked(prisma.notification.findMany).mock.calls[0][0];
    expect(findCall?.where).toMatchObject({ userId: 'u-1', readAt: null });
  });

  it('includeRead=true で既読も含める', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', systemRole: 'general' } as never);
    const res = await GET(getReq('?includeRead=true'));
    expect(res.status).toBe(200);
    const findCall = vi.mocked(prisma.notification.findMany).mock.calls[0][0];
    expect(findCall?.where).toEqual({ userId: 'u-1' });
  });

  it('limit=50 を渡すと findMany.take=50', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', systemRole: 'general' } as never);
    await GET(getReq('?limit=50'));
    const findCall = vi.mocked(prisma.notification.findMany).mock.calls[0][0];
    expect(findCall?.take).toBe(50);
  });

  it('limit が 100 超なら 400 (上限超過)', async () => {
    vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-1', systemRole: 'general' } as never);
    const res = await GET(getReq('?limit=999'));
    expect(res.status).toBe(400);
  });
});
