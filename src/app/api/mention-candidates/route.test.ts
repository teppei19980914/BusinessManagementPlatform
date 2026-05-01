import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  prisma: {
    user: { findMany: vi.fn() },
    projectMember: { findMany: vi.fn() },
    task: { findFirst: vi.fn() },
    stakeholder: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/api-helpers', () => ({
  getAuthenticatedUser: vi.fn(),
}));

import { GET } from './route';
import { prisma } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/api-helpers';

function getReq(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/mention-candidates${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthenticatedUser).mockResolvedValue({ id: 'u-me', systemRole: 'general' } as never);
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);
});

describe('GET /api/mention-candidates — 認可', () => {
  it('未認証は 401', async () => {
    const { NextResponse } = await import('next/server');
    vi.mocked(getAuthenticatedUser).mockResolvedValue(
      NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 }) as never,
    );
    const res = await GET(getReq('?entityType=issue'));
    expect(res.status).toBe(401);
  });

  it('entityType 不正は 400', async () => {
    const res = await GET(getReq('?entityType=unknown'));
    expect(res.status).toBe(400);
  });
});

describe('groups 絞り込み (entityType + context)', () => {
  it('issue + project_list 経路: 全 group kind を返す', async () => {
    const res = await GET(getReq('?entityType=issue&context=project_list'));
    const json = await res.json();
    const kinds = json.data.groups.map((g: { kind: string }) => g.kind);
    expect(kinds).toContain('all');
    expect(kinds).toContain('project_member');
    expect(kinds).toContain('role_pm_tl');
    expect(kinds).toContain('role_general');
    expect(kinds).toContain('role_viewer');
    expect(kinds).toContain('assignee');
  });

  it('issue + cross_list: all / assignee のみ (project 関連は隠す、ユーザ spec)', async () => {
    const res = await GET(getReq('?entityType=issue&context=cross_list'));
    const json = await res.json();
    const kinds = json.data.groups.map((g: { kind: string }) => g.kind);
    expect(kinds).toEqual(['all', 'assignee']);
  });

  it('task + wbs: all を隠し、project 関連を残す', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue(null);
    const res = await GET(getReq('?entityType=task&context=wbs&entityId=00000000-0000-4000-8000-000000000001'));
    const json = await res.json();
    const kinds = json.data.groups.map((g: { kind: string }) => g.kind);
    expect(kinds).not.toContain('all');
    expect(kinds).toContain('project_member');
    expect(kinds).toContain('role_pm_tl');
    expect(kinds).toContain('assignee');
  });

  it('customer: 個別 user のみ (group ゼロ)', async () => {
    const res = await GET(getReq('?entityType=customer'));
    const json = await res.json();
    expect(json.data.groups).toEqual([]);
  });
});

describe('users 候補', () => {
  it('issue: 認証済全 user (active のみ)', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-1', name: 'Alice', email: 'a@example.com' },
    ] as never);
    const res = await GET(getReq('?entityType=issue'));
    const json = await res.json();
    expect(json.data.users).toHaveLength(1);
    const call = vi.mocked(prisma.user.findMany).mock.calls[0][0];
    expect(call?.where).toMatchObject({
      isActive: true, deletedAt: null, permanentLock: false,
    });
  });

  it('task: project member のみ (entityId から projectId 解決)', async () => {
    vi.mocked(prisma.task.findFirst).mockResolvedValue({ projectId: 'p-1' } as never);
    vi.mocked(prisma.projectMember.findMany).mockResolvedValue([
      {
        user: { id: 'u-m', name: 'Member', email: 'm@example.com', isActive: true, deletedAt: null },
      },
    ] as never);
    const res = await GET(getReq('?entityType=task&entityId=00000000-0000-4000-8000-000000000001'));
    const json = await res.json();
    expect(json.data.users).toEqual([{ id: 'u-m', name: 'Member', email: 'm@example.com' }]);
  });

  it('customer: admin のみ', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'u-admin', name: 'Admin', email: 'admin@example.com' },
    ] as never);
    const res = await GET(getReq('?entityType=customer'));
    const json = await res.json();
    expect(json.data.users).toHaveLength(1);
    const call = vi.mocked(prisma.user.findMany).mock.calls[0][0];
    expect(call?.where).toMatchObject({ systemRole: 'admin' });
  });

  it('query で名前 LIKE フィルタ', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);
    await GET(getReq('?entityType=issue&query=tana'));
    const call = vi.mocked(prisma.user.findMany).mock.calls[0][0];
    expect(call?.where).toMatchObject({ name: { contains: 'tana', mode: 'insensitive' } });
  });
});
